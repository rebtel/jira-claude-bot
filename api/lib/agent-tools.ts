/**
 * Agent Tool Definitions
 * Defines all tools available to the Claude agent for code implementation
 */

import Anthropic from '@anthropic-ai/sdk';

export function getAgentTools(): Anthropic.Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file from the repository. Use this to understand existing code before making changes.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path in the repository (e.g., "src/components/Modal.tsx")'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'list_files',
      description: 'List files and directories in a path. Use this to explore the project structure and find relevant files.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path in the repository (e.g., "src/components" or "" for root)'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'search_code',
      description: 'Search for code patterns or text across the entire repository. Use this to find specific components, functions, or patterns.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "PhoneNumberModal", "onClick", etc.)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'get_default_branch',
      description: 'Get the default branch (usually main or master) of the repository',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'create_branch',
      description: 'Create a new branch from the default branch',
      input_schema: {
        type: 'object',
        properties: {
          branch_name: {
            type: 'string',
            description: 'Name of the new branch to create'
          }
        },
        required: ['branch_name']
      }
    },
    {
      name: 'update_file',
      description: 'Update an EXISTING file in the repository. You MUST read the file with read_file first before updating it. Only use this for files that already exist in the codebase.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path in the repository'
          },
          content: {
            type: 'string',
            description: 'The complete new content for the file'
          },
          message: {
            type: 'string',
            description: 'Commit message describing the change'
          }
        },
        required: ['path', 'content', 'message']
      }
    },
    {
      name: 'create_file',
      description: 'Create a NEW file in the repository. WARNING: Avoid using this unless absolutely necessary. You should prefer updating existing files. Only create new files if the requirement explicitly needs a new file that does not exist.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path for the new file'
          },
          content: {
            type: 'string',
            description: 'Content for the new file'
          },
          message: {
            type: 'string',
            description: 'Commit message'
          }
        },
        required: ['path', 'content', 'message']
      }
    },
    {
      name: 'request_code_review',
      description: 'Request a code review from an AI reviewer. MUST be called after making code changes and BEFORE creating a pull request. The reviewer will analyze your changes and provide feedback.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request. WARNING: You MUST call request_code_review first and address any feedback before calling this.',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'PR title'
          },
          body: {
            type: 'string',
            description: 'PR description'
          }
        },
        required: ['title', 'body']
      }
    }
  ];
}

export function getInitialPrompt(
  issueKey: string,
  summary: string,
  description: string,
  owner: string,
  repo: string,
  branchName: string
): string {
  return `
You have tools to interact with GitHub. Please implement this Jira ticket:

**Jira Ticket:** ${issueKey} - ${summary}
**Details:** ${description}
**Repository:** ${owner}/${repo}
**Branch to create:** ${branchName}

⚠️ CRITICAL: You MUST modify existing code, NOT create new files from scratch!

Your workflow MUST be:

1. Get the default branch
2. **EXPLORE THE CODEBASE FIRST:**
   - Use list_files to understand the project structure
   - Use search_code to find components/files related to the ticket (search for keywords from the ticket)
   - Use read_file to examine ALL relevant existing files
   - Understand the existing patterns, naming conventions, and architecture

3. **MODIFY EXISTING FILES ONLY:**
   - You have two tools: update_file (for existing files) and create_file (almost never use this)
   - You MUST use update_file to modify existing code - this is the primary way to implement changes
   - The update_file tool will ERROR if you haven't read the file first - this is intentional!
   - DO NOT create new components, new files, or new modules unless the ticket explicitly requires something completely new
   - Make surgical edits to existing files to add the requested functionality

4. Create a new branch called "${branchName}"
5. Use update_file on the files you've read and need to modify
6. **REQUEST CODE REVIEW:**
   - After making changes, call the request_code_review tool
   - An AI reviewer will analyze your changes and provide feedback
   - If the reviewer finds issues, address them by making additional changes
   - You can call request_code_review again after revisions to confirm fixes
7. Create a pull request ONLY after review is complete with title "${issueKey}: ${summary}"

**Remember:**
- 99% of tickets should only use update_file, NOT create_file. Always prefer modifying existing code.
- You MUST call request_code_review before create_pull_request
    `.trim();
}
