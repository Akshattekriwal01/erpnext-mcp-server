#!/usr/bin/env node

/**
 * ERPNext MCP Server
 * This server provides integration with the ERPNext/Frappe API, allowing:
 * - Authentication with ERPNext
 * - Fetching documents from ERPNext
 * - Querying lists of documents
 * - Creating and updating documents
 * - Running reports
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

const formatAxiosError = (error: any): string => {
  const status = error?.response?.status;
  const data = error?.response?.data;
  if (data) {
    // Extract clean error message from ERPNext's _server_messages (used in 417, 409, 403, etc.)
    if (data._server_messages) {
      try {
        const serverMessages = JSON.parse(data._server_messages);
        const cleanMessages = serverMessages.map((msg: string) => {
          try {
            const parsed = JSON.parse(msg);
            // Strip HTML tags for cleaner output
            return (parsed.message || parsed).replace(/<[^>]*>/g, '');
          } catch {
            return msg;
          }
        });
        return `[${status}] ${cleanMessages.join(' | ')}`;
      } catch {
        // Fall through to generic handling
      }
    }
    // Extract from exception field
    if (data.exception) {
      const match = data.exception.match(/:\s*(.+?)(?:\n|$)/);
      if (match) {
        return `[${status}] ${match[1].replace(/<[^>]*>/g, '')}`;
      }
    }
    // Extract from exc_type
    if (data.exc_type && data.exception) {
      return `[${status}] ${data.exc_type}: ${data.exception.split('\n')[0]}`;
    }
    try {
      return `[${status}] ${JSON.stringify(data)}`;
    } catch {
      return `[${status}] ${String(data)}`;
    }
  }
  return error?.message || 'Unknown error';
};

/**
 * Convert dict-style filters to list-of-lists format for reliable Frappe API calls.
 * Dict format: {"field": "value"} or {"field": ["operator", "value"]}
 * List format: [["field", "=", "value"]] or [["field", "operator", "value"]]
 * The list-of-lists format handles all operators (in, like, between, etc.) reliably.
 */
const normalizeFilters = (filters: Record<string, any>): any[] => {
  const result: any[] = [];
  for (const [field, value] of Object.entries(filters)) {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string') {
      // Operator format: {"field": ["operator", "operand"]}
      result.push([field, value[0], value[1]]);
    } else {
      // Simple equality: {"field": "value"}
      result.push([field, "=", value]);
    }
  }
  return result;
};

// ERPNext API client configuration
class ERPNextClient {
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private authenticated: boolean = false;

  constructor() {
    // Get ERPNext configuration from environment variables
    this.baseUrl = process.env.ERPNEXT_URL || '';
    
    // Validate configuration
    if (!this.baseUrl) {
      throw new Error("ERPNEXT_URL environment variable is required");
    }
    
    // Remove trailing slash if present
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
    
    // Initialize axios instance
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    // Configure authentication if credentials provided
    const apiKey = process.env.ERPNEXT_API_KEY;
    const apiSecret = process.env.ERPNEXT_API_SECRET;
    
    if (apiKey && apiSecret) {
      this.axiosInstance.defaults.headers.common['Authorization'] = 
        `token ${apiKey}:${apiSecret}`;
      this.authenticated = true;
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  // Get a document by doctype and name
  async getDocument(doctype: string, name: string): Promise<any> {
    try {
      const response = await this.axiosInstance.get(`/api/resource/${doctype}/${name}`);
      return response.data.data;
    } catch (error: any) {
      throw new Error(`Failed to get ${doctype} ${name}: ${formatAxiosError(error)}`);
    }
  }

  // Submit a document (docstatus = 1)
  // Uses PUT API to avoid race condition with frappe.client.submit
  // (frappe.client.submit requires fetching the doc first, but the modified
  // timestamp can change between fetch and submit, causing "modified after opened" errors)
  async submitDocument(doctype: string, name: string): Promise<any> {
    try {
      const response = await this.axiosInstance.put(`/api/resource/${doctype}/${name}`, {
        data: { docstatus: 1 }
      });
      return response.data.data;
    } catch (error: any) {
      throw new Error(`Failed to submit ${doctype} ${name}: ${formatAxiosError(error)}`);
    }
  }

  // Get list of documents for a doctype
  async getDocList(doctype: string, filters?: Record<string, any>, fields?: string[], limit?: number): Promise<any[]> {
    try {
      let params: Record<string, any> = {};
      
      if (fields && fields.length) {
        params['fields'] = JSON.stringify(fields);
      }
      
      if (filters) {
        params['filters'] = JSON.stringify(normalizeFilters(filters));
      }
      
      if (limit) {
        params['limit_page_length'] = limit;
      }
      
      const response = await this.axiosInstance.get(`/api/resource/${doctype}`, { params });
      return response.data.data;
    } catch (error: any) {
      throw new Error(`Failed to get ${doctype} list: ${formatAxiosError(error)}`);
    }
  }

  // Get count of documents for a doctype (handles child doctypes gracefully)
  async getCount(doctype: string, filters?: Record<string, any>): Promise<number> {
    try {
      // Try frappe.client.get_count first (works for regular doctypes)
      const args: Record<string, any> = { doctype };
      if (filters) {
        args.filters = normalizeFilters(filters);
      }
      const response = await this.axiosInstance.post('/api/method/frappe.client.get_count', args);
      return response.data?.message ?? 0;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 403) {
        // Permission denied — likely a child doctype. Fall back to get_list with count.
        try {
          const params: Record<string, any> = {
            fields: JSON.stringify(["count(name) as total"]),
            limit_page_length: 1
          };
          if (filters) {
            params['filters'] = JSON.stringify(normalizeFilters(filters));
          }
          const listResponse = await this.axiosInstance.get(`/api/resource/${doctype}`, { params });
          const data = listResponse.data?.data;
          if (Array.isArray(data) && data.length > 0 && data[0].total !== undefined) {
            return data[0].total;
          }
          return 0;
        } catch {
          // If list API also fails, re-throw the original error
          throw new Error(`Failed to get count for ${doctype}: ${formatAxiosError(error)}`);
        }
      }
      throw new Error(`Failed to get count for ${doctype}: ${formatAxiosError(error)}`);
    }
  }

  // Get DocType metadata
  async getDocTypeMeta(doctype: string): Promise<any> {
    try {
      const response = await this.axiosInstance.get(`/api/resource/DocType/${doctype}`);
      return response.data.data;
    } catch (error: any) {
      // Fallback to getdoctype method (works when list/resource is restricted)
      try {
        const altResponse = await this.axiosInstance.get('/api/method/frappe.desk.form.load.getdoctype', {
          params: { doctype }
        });
        const msg = altResponse.data?.message;
        if (msg?.docs && Array.isArray(msg.docs) && msg.docs.length) {
          return msg.docs[0];
        }
        if (msg?.doc) {
          return msg.doc;
        }
        if (Array.isArray(msg) && msg.length) {
          return msg[0];
        }
      } catch (altError: any) {
        throw new Error(`Failed to get DocType ${doctype}: ${altError?.message || error?.message || 'Unknown error'}`);
      }
      throw new Error(`Failed to get DocType ${doctype}: ${formatAxiosError(error)}`);
    }
  }

  // Get singleton document by doctype
  async getSingleton(doctype: string): Promise<any> {
    try {
      const response = await this.axiosInstance.get(`/api/resource/${doctype}/${doctype}`);
      return response.data.data;
    } catch (error: any) {
      // Fallback to getdoc method
      try {
        const altResponse = await this.axiosInstance.get('/api/method/frappe.desk.form.load.getdoc', {
          params: { doctype, name: doctype }
        });
        const msg = altResponse.data?.message;
        if (msg?.docs && Array.isArray(msg.docs) && msg.docs.length) {
          return msg.docs[0];
        }
        if (msg?.doc) {
          return msg.doc;
        }
      } catch (altError: any) {
        throw new Error(`Failed to get singleton ${doctype}: ${altError?.message || error?.message || 'Unknown error'}`);
      }
      throw new Error(`Failed to get singleton ${doctype}: ${formatAxiosError(error)}`);
    }
  }

  // Create a new document
  async createDocument(doctype: string, doc: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.post(`/api/resource/${doctype}`, {
        data: doc
      });
      return response.data.data;
    } catch (error: any) {
      throw new Error(`Failed to create ${doctype}: ${formatAxiosError(error)}`);
    }
  }

  // Update an existing document
  async updateDocument(doctype: string, name: string, doc: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.put(`/api/resource/${doctype}/${name}`, {
        data: doc
      });
      return response.data.data;
    } catch (error: any) {
      throw new Error(`Failed to update ${doctype} ${name}: ${formatAxiosError(error)}`);
    }
  }

  // Cancel a submitted document (docstatus = 2)
  async cancelDocument(doctype: string, name: string): Promise<any> {
    try {
      const response = await this.axiosInstance.post('/api/method/frappe.client.cancel', {
        doctype,
        name
      });
      return response.data?.message || response.data?.data || response.data;
    } catch (error: any) {
      throw new Error(`Failed to cancel ${doctype} ${name}: ${formatAxiosError(error)}`);
    }
  }

  // Delete a document
  async deleteDocument(doctype: string, name: string): Promise<any> {
    try {
      const response = await this.axiosInstance.delete(`/api/resource/${doctype}/${name}`);
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to delete ${doctype} ${name}: ${formatAxiosError(error)}`);
    }
  }

  // Call a Frappe/ERPNext whitelisted method
  async callMethod(method: string, args?: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.post(`/api/method/${method}`, args || {});
      return response.data?.message || response.data;
    } catch (error: any) {
      throw new Error(`Failed to call method ${method}: ${formatAxiosError(error)}`);
    }
  }

  // Run a report
  async runReport(reportName: string, filters?: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.get(`/api/method/frappe.desk.query_report.run`, {
        params: {
          report_name: reportName,
          filters: filters ? JSON.stringify(filters) : undefined
        }
      });
      return response.data.message;
    } catch (error: any) {
      throw new Error(`Failed to run report ${reportName}: ${formatAxiosError(error)}`);
    }
  }

  // Get all available DocTypes
  async getAllDocTypes(): Promise<string[]> {
    try {
      // Use the standard REST API to fetch DocTypes
      const response = await this.axiosInstance.get('/api/resource/DocType', {
        params: {
          fields: JSON.stringify(["name"]),
          limit_page_length: 500 // Get more doctypes at once
        }
      });
      
      if (response.data && response.data.data) {
        return response.data.data.map((item: any) => item.name);
      }
      
      return [];
    } catch (error: any) {
      console.error("Failed to get DocTypes:", formatAxiosError(error));
      
      // Try an alternative approach if the first one fails
      try {
        // Try using the method API to get doctypes
        const altResponse = await this.axiosInstance.get('/api/method/frappe.desk.search.search_link', {
          params: {
            doctype: 'DocType',
            txt: '',
            limit: 500
          }
        });
        
        if (altResponse.data && altResponse.data.results) {
          return altResponse.data.results.map((item: any) => item.value);
        }
        
        return [];
      } catch (altError: any) {
        console.error("Alternative DocType fetch failed:", altError?.message || 'Unknown error');
        
        // Fallback: Return a list of common DocTypes
        return [
          "Customer", "Supplier", "Item", "Sales Order", "Purchase Order",
          "Sales Invoice", "Purchase Invoice", "Employee", "Lead", "Opportunity",
          "Quotation", "Payment Entry", "Journal Entry", "Stock Entry"
        ];
      }
    }
  }
}

// Cache for doctype metadata
const doctypeCache = new Map<string, any>();

// Initialize ERPNext client
const erpnext = new ERPNextClient();

// Create an MCP server with capabilities for resources and tools
const server = new Server(
  {
    name: "erpnext-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);

/**
 * Handler for listing available ERPNext resources.
 * Exposes DocTypes list as a resource and common doctypes as individual resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // List of common DocTypes to expose as individual resources
  const commonDoctypes = [
    "Customer",
    "Supplier",
    "Item",
    "Sales Order",
    "Purchase Order",
    "Sales Invoice",
    "Purchase Invoice",
    "Employee"
  ];

  const resources = [
    // Add a resource to get all doctypes
    {
      uri: "erpnext://DocTypes",
      name: "All DocTypes",
      mimeType: "application/json",
      description: "List of all available DocTypes in the ERPNext instance"
    }
  ];

  return {
    resources
  };
});

/**
 * Handler for resource templates.
 * Allows querying ERPNext documents by doctype and name.
 */
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  const resourceTemplates = [
    {
      uriTemplate: "erpnext://{doctype}/{name}",
      name: "ERPNext Document",
      mimeType: "application/json",
      description: "Fetch an ERPNext document by doctype and name"
    }
  ];

  return { resourceTemplates };
});

/**
 * Handler for reading ERPNext resources.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (!erpnext.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated with ERPNext. Please configure API key authentication."
    );
  }

  const uri = request.params.uri;
  let result: any;

  // Handle special resource: erpnext://DocTypes (list of all doctypes)
  if (uri === "erpnext://DocTypes") {
    try {
      const doctypes = await erpnext.getAllDocTypes();
      result = { doctypes };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch DocTypes: ${formatAxiosError(error)}`
      );
    }
  } else {
    // Handle document access: erpnext://{doctype}/{name}
    const documentMatch = uri.match(/^erpnext:\/\/([^\/]+)\/(.+)$/);
    if (documentMatch) {
      const doctype = decodeURIComponent(documentMatch[1]);
      const name = decodeURIComponent(documentMatch[2]);
      
      try {
        result = await erpnext.getDocument(doctype, name);
      } catch (error: any) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Failed to fetch ${doctype} ${name}: ${formatAxiosError(error)}`
        );
      }
    }
  }

  if (!result) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid ERPNext resource URI: ${uri}`
    );
  }

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2)
    }]
  };
});

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_doctypes",
        description: "Get a list of all available DocTypes",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "get_doctype_fields",
        description: "Get fields list for a specific DocType",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            }
          },
            required: ["doctype"]
        }
      },
      {
        name: "get_documents",
        description: "Get a list of documents for a specific doctype",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            fields: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Fields to include (optional)"
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Filters in the format {field: value} (optional)"
            },
            limit: {
              type: "number",
              description: "Maximum number of documents to return (optional)"
            }
          },
          required: ["doctype"]
        }
      },
      {
        name: "get_document",
        description: "Get a single document by doctype and name",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "create_document",
        description: "Create a new document in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            data: {
              type: "object",
              additionalProperties: true,
              description: "Document data"
            }
          },
          required: ["doctype", "data"]
        }
      },
      {
        name: "update_document",
        description: "Update an existing document in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            },
            data: {
              type: "object",
              additionalProperties: true,
              description: "Document data to update"
            }
          },
          required: ["doctype", "name", "data"]
        }
      },
      {
        name: "submit_document",
        description: "Submit a document (docstatus = 1) in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Purchase Order, Sales Invoice)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "cancel_document",
        description: "Cancel a submitted document (docstatus = 2) in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Stock Entry, Sales Invoice)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "delete_document",
        description: "Delete a document from ERPNext (use with caution)",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "get_count",
        description: "Get the count of documents for a doctype (handles child doctypes gracefully)",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item, Item Default)"
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Filters in the format {field: value} (optional)"
            }
          },
          required: ["doctype"]
        }
      },
      {
        name: "call_method",
        description: "Call a whitelisted Frappe/ERPNext API method",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "Dotted method path (e.g., frappe.client.get_count)"
            },
            args: {
              type: "object",
              additionalProperties: true,
              description: "Method arguments (optional)"
            }
          },
          required: ["method"]
        }
      },
      {
        name: "run_report",
        description: "Run an ERPNext report",
        inputSchema: {
          type: "object",
          properties: {
            report_name: {
              type: "string",
              description: "Name of the report"
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Report filters (optional)"
            }
          },
          required: ["report_name"]
        }
      }
    ]
  };
});

/**
 * Handler for tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "get_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const doctype = String(request.params.arguments?.doctype);
      const name = String(request.params.arguments?.name);

      if (!doctype || !name) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and name are required"
        );
      }

      try {
        const doc = await erpnext.getDocument(doctype, name);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(doc, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get ${doctype} ${name}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "get_documents": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      const doctype = String(request.params.arguments?.doctype);
      const fields = request.params.arguments?.fields as string[] | undefined;
      const filters = request.params.arguments?.filters as Record<string, any> | undefined;
      const limit = request.params.arguments?.limit as number | undefined;
      
      if (!doctype) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype is required"
        );
      }
      
      try {
        // Use DocType metadata to detect singletons
        try {
          const meta = await erpnext.getDocTypeMeta(doctype);
          if (meta?.is_single) {
            const doc = await erpnext.getSingleton(doctype);
            let result: any = doc;
            if (fields && fields.length) {
              result = fields.reduce((acc: any, field: string) => {
                acc[field] = doc?.[field];
                return acc;
              }, {});
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify([result], null, 2)
              }]
            };
          }
        } catch {
          // Ignore metadata errors and fall back to list API
        }

        const documents = await erpnext.getDocList(doctype, filters, fields, limit);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(documents, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get ${doctype} documents: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }
    
    case "create_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      const doctype = String(request.params.arguments?.doctype);
      const data = request.params.arguments?.data as Record<string, any> | undefined;
      
      if (!doctype || !data) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and data are required"
        );
      }
      
      try {
        const result = await erpnext.createDocument(doctype, data);
        return {
          content: [{
            type: "text",
            text: `Created ${doctype}: ${result.name}\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to create ${doctype}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "submit_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const doctype = String(request.params.arguments?.doctype);
      const name = String(request.params.arguments?.name);

      if (!doctype || !name) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and name are required"
        );
      }

      try {
        const result = await erpnext.submitDocument(doctype, name);
        return {
          content: [{
            type: "text",
            text: `Submitted ${doctype} ${name}\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to submit ${doctype} ${name}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "update_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      const doctype = String(request.params.arguments?.doctype);
      const name = String(request.params.arguments?.name);
      const data = request.params.arguments?.data as Record<string, any> | undefined;
      
      if (!doctype || !name || !data) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype, name, and data are required"
        );
      }
      
      try {
        const result = await erpnext.updateDocument(doctype, name, data);
        return {
          content: [{
            type: "text",
            text: `Updated ${doctype} ${name}\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to update ${doctype} ${name}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }
    
    case "run_report": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      const reportName = String(request.params.arguments?.report_name);
      const filters = request.params.arguments?.filters as Record<string, any> | undefined;
      
      if (!reportName) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Report name is required"
        );
      }
      
      try {
        const result = await erpnext.runReport(reportName, filters);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to run report ${reportName}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }
    
    case "get_doctype_fields": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      const doctype = String(request.params.arguments?.doctype);
      
      if (!doctype) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype is required"
        );
      }
      
      try {
        // Prefer DocType metadata (works even when no documents exist)
        try {
          const meta = await erpnext.getDocTypeMeta(doctype);
          if (meta?.fields && Array.isArray(meta.fields)) {
            const fields = meta.fields.map((field: any) => ({
              fieldname: field.fieldname,
              fieldtype: field.fieldtype,
              reqd: field.reqd ?? 0,
              options: field.options ?? null
            }));
            return {
              content: [{
                type: "text",
                text: JSON.stringify(fields, null, 2)
              }]
            };
          }
        } catch {
          // Ignore metadata errors and fall back to sample document
        }

        // Fallback: Get a sample document to understand the fields
        const documents = await erpnext.getDocList(doctype, {}, ["*"], 1);
        
        if (!documents || documents.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No documents found for ${doctype}. Cannot determine fields.`
            }],
            isError: true
          };
        }
        
        // Extract field names from the first document
        const sampleDoc = documents[0];
        const fields = Object.keys(sampleDoc).map(field => ({
          fieldname: field,
          value: typeof sampleDoc[field],
          sample: sampleDoc[field]?.toString()?.substring(0, 50) || null
        }));
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(fields, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get fields for ${doctype}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }
    
    case "cancel_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const doctype = String(request.params.arguments?.doctype);
      const name = String(request.params.arguments?.name);

      if (!doctype || !name) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and name are required"
        );
      }

      try {
        const result = await erpnext.cancelDocument(doctype, name);
        return {
          content: [{
            type: "text",
            text: `Cancelled ${doctype} ${name}\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to cancel ${doctype} ${name}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "delete_document": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const doctype = String(request.params.arguments?.doctype);
      const name = String(request.params.arguments?.name);

      if (!doctype || !name) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and name are required"
        );
      }

      try {
        const result = await erpnext.deleteDocument(doctype, name);
        return {
          content: [{
            type: "text",
            text: `Deleted ${doctype} ${name}\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to delete ${doctype} ${name}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "get_count": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const doctype = String(request.params.arguments?.doctype);
      const filters = request.params.arguments?.filters as Record<string, any> | undefined;

      if (!doctype) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype is required"
        );
      }

      try {
        const count = await erpnext.getCount(doctype, filters);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ doctype, count }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get count for ${doctype}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "call_method": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }

      const method = String(request.params.arguments?.method);
      const args = request.params.arguments?.args as Record<string, any> | undefined;

      if (!method) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Method is required"
        );
      }

      try {
        const result = await erpnext.callMethod(method, args);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to call method ${method}: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }

    case "get_doctypes": {
      if (!erpnext.isAuthenticated()) {
        return {
          content: [{
            type: "text",
            text: "Not authenticated with ERPNext. Please configure API key authentication."
          }],
          isError: true
        };
      }
      
      try {
        const doctypes = await erpnext.getAllDocTypes();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(doctypes, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get DocTypes: ${formatAxiosError(error)}`
          }],
          isError: true
        };
      }
    }
      
    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
  }
});

/**
 * Start the server using stdio transport.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ERPNext MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
