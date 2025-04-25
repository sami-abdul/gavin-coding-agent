# Gavin Coding Agent

A Node.js server that generates complete, structured web application projects by combining code generation from OpenAI Assistants with local scaffolding commands, and deploying them to Vercel.

## Overview

Gavin uses a hybrid approach to create full-featured web applications:

1. It uses the OpenAI Assistants API to generate all the necessary code files
2. It runs local scaffolding commands (like `create-vite` or `create-next-app`) to set up a proper project structure
3. It combines the generated code with the scaffolded structure to create a complete, ready-to-run project
4. Optionally, it deploys the generated project to Vercel and provides a public URL

This approach solves the limitation that OpenAI's Code Interpreter cannot run npm/npx commands, while still leveraging the AI's code generation capabilities.

## Key Features

- Generates entire project directories with proper structure
- Runs professional scaffolding tools locally (like Vite, Create React App)
- Intelligently detects project type (React, Next.js) and language (JS/TS)
- Creates appropriate configuration files (package.json, vite.config.js, etc.)
- Implements components, styles, and functionality based on the prompt
- Returns a complete, ready-to-run project
- *New:* Automatically deploys projects to Vercel and returns a public URL

## Prerequisites

- Node.js (v14 or higher recommended)
- npm or yarn
- OpenAI API key with access to the Assistants API and GPT-4 models
- An Assistant created on the OpenAI platform with appropriate settings
- *New:* Vercel account and API token (for deployment feature)

## Installation

1. Clone this repository or copy the files to your preferred location
2. Install dependencies:

```bash
npm install
```

3. Create an Assistant on the OpenAI platform:
   - Go to [OpenAI Platform](https://platform.openai.com)
   - Navigate to "Assistants" in the left sidebar
   - Click "Create"
   - Name: "Gaving Coding Agent" (or any name you prefer)
   - Instructions: 
     ```
     You are an expert web developer. Your job is to generate code for complete web applications based on user prompts.

     DO NOT try to run npm/npx commands. Instead, just provide the code files that would be needed for the project.
     
     For each code file, use this format:
     ```language
     // filename: path/to/filename.ext
     // Code content here
     ```
     
     Be sure to include ALL necessary files:
     1. React/Next.js components
     2. CSS/styling files
     3. Configuration files (package.json, vite.config.js, etc.)
     4. Main entry points (index.js, App.js, etc.)
     5. Any utilities, hooks, or helpers
     ```
   - Model: GPT-4 or GPT-4 Turbo (gpt-4o recommended)
   - Temperature: 0.3 (for more focused responses)
   - Enable Code Interpreter (used for code formatting, not scaffolding)
   - Save and copy the Assistant ID (starts with "asst_")

4. *New:* Get a Vercel API token:
   - Log in to your [Vercel account](https://vercel.com)
   - Go to Account Settings → Tokens
   - Create a new token with appropriate permissions
   - Copy the token value

5. Create a `.env` file (copy from `env.example`):

```bash
cp env.example .env
```

6. Edit the `.env` file with your API keys and IDs:

```
OPENAI_API_KEY=sk-your-openai-api-key-here
ASSISTANT_ID=asst_your-assistant-id-here
PORT=3001
VERCEL_TOKEN=your-vercel-token-here  # Only needed if you want to enable automatic deployment
```

## Usage

### Start the Server

```bash
npm start
```

The server will start on port 3001 by default (or the port specified in your `.env` file).

### API Endpoints

#### Generate and Deploy a Project

Make a POST request to `/generateProject` with a JSON body containing the prompt:

```bash
curl -X POST http://localhost:3001/generateProject \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a React app that displays current weather for a given city using OpenWeatherMap API"}'
```

The response will look like:

```json
{
  "success": true,
  "message": "Project generation and deployment started",
  "jobId": "a1b2c3d4e5f6g7h8",
  "status": "pending",
  "statusUrl": "/getDeploymentStatus?jobId=a1b2c3d4e5f6g7h8"
}
```

#### Check Deployment Status

To check the status of a project generation and deployment job, make a GET request to the provided `statusUrl`:

```bash
curl "http://localhost:3001/getDeploymentStatus?jobId=a1b2c3d4e5f6g7h8"
```

The response during processing:

```json
{
  "success": true,
  "jobId": "a1b2c3d4e5f6g7h8",
  "status": "deploying",
  "created": 1702342500000,
  "lastUpdated": 1702342650000
}
```

The final successful response:

```json
{
  "success": true,
  "jobId": "a1b2c3d4e5f6g7h8",
  "status": "completed",
  "created": 1702342500000,
  "lastUpdated": 1702342800000,
  "outputDir": "generated_projects/a1b2c3d4e5f6g7h8",
  "files": ["package.json", "index.html", "src/App.jsx", ...],
  "deploymentUrl": "https://ai-project-a1b2c3d4e5f6g7h8.vercel.app"
}
```

To include the full file contents (which can be large), add `includeFiles=true` to the query:

```bash
curl "http://localhost:3001/getDeploymentStatus?jobId=a1b2c3d4e5f6g7h8&includeFiles=true"
```

### Test Client

For convenience, a test client is included:

```bash
npm test
```

This will prompt you to enter a project description or use the default.

## How It Works

1. The server receives a prompt for project generation
2. It creates a background job and returns a job ID immediately
3. In the background:
   - It sends the prompt to the OpenAI Assistant to generate code files
   - The Assistant responds with code for components, styling, configuration, etc.
   - The server extracts all code blocks from the Assistant's response
   - It analyzes the code to detect framework type (React/Next.js), language (JS/TS), etc.
   - It runs the appropriate local scaffolding command (create-vite, create-next-app)
   - It integrates the generated code into the scaffolded project structure
   - If Vercel deployment is enabled, it deploys the project to Vercel
4. The client can poll the status endpoint to monitor progress and get the final result

## Implementation Details

- Uses local scaffolding tools for reliable project structure creation
- Intelligent code parsing extracts both files and project metadata
- Automatic detection of React vs Next.js, JavaScript vs TypeScript
- Support for additional features like Tailwind CSS
- Asynchronous processing with status monitoring API
- Optional deployment to Vercel with automatic authentication

## Notes and Limitations

- The Agent should not try to run npm/npx commands - it should only generate code
- Local scaffolding requires npm and Node.js to be installed on the server
- Some complex project requirements may need manual adjustments after generation
- The server does not implement authentication or rate limiting
- Vercel deployment may fail for certain complex project types or configurations
- Deployed projects are maintained in your Vercel account and may incur costs
- There is no automatic cleanup of old deployments - you must manage this manually

## License

This project is provided as-is. Use it at your own risk. 