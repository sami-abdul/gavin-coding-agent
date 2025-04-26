/**
 * assistant-server.js - API server for project generation using OpenAI Assistants or Google's Gemini with Code Interpreter
 * 
 * This server creates complete, structured web application projects by combining
 * code generation from OpenAI Assistants or Google's Gemini with local scaffolding commands.
 */

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const AdmZip = require('adm-zip');
const { promisify } = require('util');
const { spawn, exec } = require('child_process');
const sleep = promisify(setTimeout);

// Create Express app
const app = express();
const port = process.env.PORT || 3001; // Use 3001 to avoid conflict with codex-server

// Apply middleware
app.use(express.json());
app.use(cors());

// Constants
const OUTPUT_DIR_BASE = path.join(__dirname, 'generated_projects');
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const POLLING_INTERVAL_MS = 2000; // 2 seconds
const MAX_POLLING_ATTEMPTS = 300; // 10 minutes (300 attempts * 2 seconds)
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

// Store ongoing deployments for status checking
const deploymentJobs = new Map();

// Initialize API clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Verify necessary environment variables
if (!process.env.OPENAI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error('Error: Either OPENAI_API_KEY or GOOGLE_API_KEY environment variable is required');
  process.exit(1);
}

if (!ASSISTANT_ID && !process.env.GOOGLE_API_KEY) {
  console.error('Error: Either ASSISTANT_ID or GOOGLE_API_KEY environment variable is required');
  process.exit(1);
}

// Warn if Vercel token is missing
if (!VERCEL_TOKEN) {
  console.warn('Warning: VERCEL_TOKEN environment variable is not set. Deployment functionality will be disabled.');
}

// Ensure the output directory exists
if (!fs.existsSync(OUTPUT_DIR_BASE)) {
  fs.mkdirSync(OUTPUT_DIR_BASE, { recursive: true });
}

/**
 * Helper function to recursively list all files in a directory
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @returns {Array<string>} Array of file paths relative to baseDir
 */
function listFilesRecursively(dir, baseDir) {
  let results = [];
  const list = fs.readdirSync(dir);

  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat && stat.isDirectory()) {
      // Recurse into subdirectory
      results = results.concat(listFilesRecursively(fullPath, baseDir));
    } else {
      // Add file path relative to baseDir
      results.push(path.relative(baseDir, fullPath));
    }
  });

  return results;
}

/**
 * Helper function to check if a file is likely a text file based on extension
 */
function isTextFile(filename) {
  const textExtensions = [
    '.txt', '.js', '.jsx', '.ts', '.tsx', '.py', '.html', '.css', '.scss',
    '.json', '.md', '.yaml', '.yml', '.xml', '.csv', '.sh', '.bat', '.ps1',
    '.gitignore', '.env', '.c', '.cpp', '.h', '.hpp', '.java', '.rb', '.php',
    '.go', '.rs', '.swift', '.kt', '.kts', '.sql', '.prisma', '.graphql'
  ];

  const ext = path.extname(filename).toLowerCase();
  return textExtensions.includes(ext);
}

/**
 * Polls for a Run's status until it reaches a terminal state or exceeds max attempts
 * @param {string} threadId - Thread ID
 * @param {string} runId - Run ID
 * @returns {Object} The final Run object
 */
async function pollForRunCompletion(threadId, runId) {
  let attempts = 0;

  while (attempts < MAX_POLLING_ATTEMPTS) {
    attempts++;

    const run = await openai.beta.threads.runs.retrieve(threadId, runId);

    // Check if the Run reached a terminal state
    if (['completed', 'failed', 'cancelled', 'expired'].includes(run.status)) {
      return run;
    }

    // If the Run needs action, the Assistants API would normally expect us to handle that.
    // For simplicity in this implementation, we'll fail if this happens.
    if (run.status === 'requires_action') {
      console.error('Run requires action - not implemented in this version');
      run.status = 'failed'; // Treat as failure for simplicity
      return run;
    }

    // Wait before checking again
    await sleep(POLLING_INTERVAL_MS);
  }

  // If we reach here, the Run timed out
  throw new Error('Run polling timed out after maximum attempts');
}

/**
 * Extract code blocks from the Assistant's response
 * @param {string} threadId - Thread ID 
 * @returns {Object} Object containing extracted code files
 */
async function extractCodeFromAssistantResponse(threadId) {
  const extractedFiles = {};

  // List messages in the thread
  const messagesList = await openai.beta.threads.messages.list(threadId);

  // Find the most recent assistant message
  let assistantMessage = null;
  for (const message of messagesList.data) {
    if (message.role === 'assistant') {
      assistantMessage = message;
      break;
    }
  }

  if (!assistantMessage) {
    throw new Error('No assistant message found in thread');
  }

  // Extract text content from the message
  let textContent = '';
  for (const contentPart of assistantMessage.content) {
    if (contentPart.type === 'text') {
      textContent += contentPart.text.value;
    }
  }

  // Extract code blocks from the message
  // Look for markdown-style code blocks with language annotations
  const codeBlockRegex = /```([a-zA-Z0-9_+\.]+)?\s*(?:(?:\/\/|#)\s*filename:\s*([a-zA-Z0-9_\-\.\/]+))?\s*([^`]+)```/g;
  let match;

  while ((match = codeBlockRegex.exec(textContent)) !== null) {
    // Extract language, optional filename, and code content
    const lang = match[1] || 'txt';
    const explicitFilename = match[2]; // May be undefined
    const code = match[3].trim();

    // Determine filename
    let filename;
    if (explicitFilename) {
      // Use explicitly provided filename
      filename = explicitFilename;
    } else {
      // If no filename is specified, try to infer from the first line
      const firstLineMatch = code.match(/^(?:\/\/|#|\/\*)\s*filename:\s*([a-zA-Z0-9_\-\.\/]+)/);
      if (firstLineMatch) {
        filename = firstLineMatch[1];
      } else {
        // Default filename based on language
        const extension = getExtensionFromLanguage(lang);
        filename = `file${Object.keys(extractedFiles).length + 1}${extension}`;
      }
    }

    // Store the extracted code
    extractedFiles[filename] = code;
  }

  // Extract project information
  const projectInfo = {
    framework: 'react', // Default
    language: 'javascript', // Default
    cssFramework: null,
    features: []
  };

  // Try to detect framework and features from the code and message
  if (textContent.toLowerCase().includes('typescript') ||
    Object.keys(extractedFiles).some(file => file.endsWith('.ts') || file.endsWith('.tsx'))) {
    projectInfo.language = 'typescript';
  }

  if (textContent.toLowerCase().includes('tailwind') ||
    (extractedFiles['package.json'] && extractedFiles['package.json'].includes('tailwindcss'))) {
    projectInfo.cssFramework = 'tailwind';
  }

  if (textContent.toLowerCase().includes('next.js') ||
    (extractedFiles['package.json'] && extractedFiles['package.json'].includes('next'))) {
    projectInfo.framework = 'next';
  }

  return { files: extractedFiles, projectInfo };
}

/**
 * Helper function to determine file extension from code language
 * @param {string} language - Programming language identifier
 * @returns {string} - File extension including the dot
 */
function getExtensionFromLanguage(language) {
  const langMap = {
    'javascript': '.js',
    'js': '.js',
    'typescript': '.ts',
    'ts': '.ts',
    'jsx': '.jsx',
    'tsx': '.tsx',
    'python': '.py',
    'py': '.py',
    'ruby': '.rb',
    'java': '.java',
    'c': '.c',
    'cpp': '.cpp',
    'csharp': '.cs',
    'cs': '.cs',
    'go': '.go',
    'html': '.html',
    'css': '.css',
    'json': '.json',
    'yaml': '.yml',
    'shell': '.sh',
    'bash': '.sh',
    'php': '.php',
    'swift': '.swift',
    'rust': '.rs',
    'kotlin': '.kt',
    'sql': '.sql'
  };

  return langMap[language.toLowerCase()] || '.txt';
}

/**
 * Execute a shell command with proper error handling
 * @param {string} command - Command to execute
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} - Command output
 */
function executeCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Command execution error: ${error.message}`);
        console.error(`stderr: ${stderr}`);
        reject(error);
        return;
      }

      if (stderr) {
        console.warn(`Command stderr: ${stderr}`);
      }

      resolve(stdout);
    });
  });
}

/**
 * Create a new project using a scaffolding tool
 * @param {string} outputDir - Directory to create the project in
 * @param {Object} projectInfo - Information about the project type
 * @returns {Promise<string>} - Path to the created project
 */
async function createScaffoldedProject(outputDir, projectInfo) {
  // Determine scaffolding command based on project info
  let scaffoldCmd;

  if (projectInfo.framework === 'next') {
    // Next.js project
    const template = projectInfo.language === 'typescript' ? '--typescript' : '';
    scaffoldCmd = `npx create-next-app@latest . ${template} --eslint --use-npm --src-dir --app --tailwind=false`;
  } else {
    // React project with Vite
    const template = projectInfo.language === 'typescript' ? 'react-ts' : 'react';
    scaffoldCmd = `npx create-vite@latest . --template ${template}`;
  }

  console.log(`Scaffolding new project with: ${scaffoldCmd}`);

  try {
    // Execute the scaffolding command
    await executeCommand(scaffoldCmd, outputDir);

    // Install additional dependencies if needed
    if (projectInfo.cssFramework === 'tailwind' && projectInfo.framework !== 'next') {
      console.log('Installing Tailwind CSS...');
      await executeCommand('npm install -D tailwindcss postcss autoprefixer', outputDir);
      await executeCommand('npx tailwindcss init -p', outputDir);
    }

    return outputDir;
  } catch (error) {
    console.error('Error during project scaffolding:', error);
    throw error;
  }
}

/**
 * Add generated code files to the scaffolded project
 * @param {string} projectDir - Path to the scaffolded project
 * @param {Object} files - Object containing filename:content pairs
 */
async function addGeneratedCodeToProject(projectDir, files) {
  for (const [filename, content] of Object.entries(files)) {
    // Create directory for the file if it doesn't exist
    const filePath = path.join(projectDir, filename);
    const directory = path.dirname(filePath);

    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // Write file content
    fs.writeFileSync(filePath, content);
    console.log(`Added file: ${filename}`);
  }
}

/**
 * Deploy a generated project to Vercel
 * @param {string} projectDir - Path to the project directory
 * @param {string} projectName - Name to use for the deployment
 * @returns {Promise<Object>} - Deployment information including URL
 */
async function deployToVercel(projectDir, projectName) {
  if (!VERCEL_TOKEN) {
    throw new Error('Vercel token not configured. Cannot deploy project.');
  }

  try {
    console.log(`Building project in ${projectDir}...`);

    // Install dependencies if needed
    console.log('Installing dependencies...');
    await executeCommand('npm install', projectDir);

    // Ensure essential Vite/React build dependencies are installed
    // This addresses cases where the AI-generated package.json might be incomplete
    console.log('Ensuring Vite React plugin is installed...');
    await executeCommand('npm install @vitejs/plugin-react --save-dev', projectDir);

    // Remove any existing .vercel directory if it exists
    // This is crucial for resolving the "Project Settings are invalid" error
    const vercelConfigDir = path.join(projectDir, '.vercel');
    if (fs.existsSync(vercelConfigDir)) {
      console.log(`Attempting to remove existing .vercel directory: ${vercelConfigDir}`);
      try {
        fs.rmSync(vercelConfigDir, { recursive: true, force: true });
        console.log('.vercel directory removed successfully.');
      } catch (rmErr) {
        console.error(`Error removing .vercel directory: ${rmErr.message}`);
        // Decide if we should proceed or throw? For now, log and continue.
      }
    }

    // Create a .vercelignore file
    fs.writeFileSync(
      path.join(projectDir, '.vercelignore'),
      'README.md\nnode_modules\n.git'
    );

    // Deploy to Vercel with proper flags:
    // --confirm: Non-interactive equivalent of --yes in newer CLI, avoids prompting.
    // --name: Specifies a unique project name, helps Vercel create a new project if needed.
    // --prod: Ensures we deploy to production and get the production URL
    console.log('Deploying to Vercel...');
    const deployCommand = `npx vercel deploy --token=${VERCEL_TOKEN} --name=${projectName} --confirm --prod`;
    console.log(`Executing Vercel command: ${deployCommand}`);
    const deployOutput = await executeCommand(
      deployCommand,
      projectDir
    );

    // Parse deployment URL from output and ensure it's the production URL
    const urlMatch = deployOutput.match(/(https:\/\/[^\s]+)/);
    let deploymentUrl = urlMatch ? urlMatch[0].trim() : null;

    // Clean up the URL to ensure it's the production URL
    if (deploymentUrl) {
      // Remove any preview/temporary suffix (anything after '-' before .vercel.app)
      deploymentUrl = deploymentUrl.replace(/-[a-z0-9]+\.vercel\.app/, '.vercel.app');
      // Ensure trailing slash for consistency
      if (!deploymentUrl.endsWith('/')) {
        deploymentUrl += '/';
      }
    }

    if (!deploymentUrl) {
      throw new Error('Could not extract deployment URL from Vercel output');
    }

    console.log(`Deployment successful: ${deploymentUrl}`);

    return {
      success: true,
      url: deploymentUrl,
      output: deployOutput
    };
  } catch (error) {
    console.error('Deployment error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Generate code using Gemini API
 * @param {string} prompt - User's project description
 * @returns {Promise<Object>} - Generated code files and project info
 */
async function generateCodeWithGemini(prompt) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const enhancedPrompt = `
I need you to generate code for a web application based on the following requirements:

${prompt}

Please provide ALL the code files needed for this project including:
1. React components (.jsx/.tsx files)
2. CSS/Styling files
3. Configuration files (like package.json, vite.config.js, etc.)
4. Any utility functions or hooks
5. Main entry points (index.js, App.js, etc.)

For each code file, please use the format:
\`\`\`language
// filename: path/to/filename.ext
// Code content here
\`\`\`

DO NOT try to execute npm or npx commands - just provide the code files.
I will handle the setup and installation myself.
`;

    const result = await model.generateContent(enhancedPrompt);
    const response = await result.response;
    const text = response.text();

    // Extract code blocks and project info
    const { files, projectInfo } = extractCodeFromResponse(text);
    return { files, projectInfo };
  } catch (error) {
    console.error('Error generating code with Gemini:', error);
    throw error;
  }
}

/**
 * Extract code blocks from API response
 * @param {string} response - API response text
 * @returns {Object} - Extracted code files and project info
 */
function extractCodeFromResponse(response) {
  const extractedFiles = {};
  const projectInfo = {
    framework: 'react',
    language: 'javascript',
    cssFramework: null,
    features: []
  };

  // Look for markdown-style code blocks with language annotations
  const codeBlockRegex = /```([a-zA-Z0-9_+\.]+)?\s*(?:(?:\/\/|#)\s*filename:\s*([a-zA-Z0-9_\-\.\/]+))?\s*([^`]+)```/g;
  let match;

  while ((match = codeBlockRegex.exec(response)) !== null) {
    const lang = match[1] || 'txt';
    const explicitFilename = match[2];
    const code = match[3].trim();

    let filename;
    if (explicitFilename) {
      filename = explicitFilename;
    } else {
      const firstLineMatch = code.match(/^(?:\/\/|#|\/\*)\s*filename:\s*([a-zA-Z0-9_\-\.\/]+)/);
      if (firstLineMatch) {
        filename = firstLineMatch[1];
      } else {
        const extension = getExtensionFromLanguage(lang);
        filename = `file${Object.keys(extractedFiles).length + 1}${extension}`;
      }
    }

    extractedFiles[filename] = code;
  }

  // Detect project type and features
  if (response.toLowerCase().includes('typescript') ||
    Object.keys(extractedFiles).some(file => file.endsWith('.ts') || file.endsWith('.tsx'))) {
    projectInfo.language = 'typescript';
  }

  if (response.toLowerCase().includes('tailwind') ||
    (extractedFiles['package.json'] && extractedFiles['package.json'].includes('tailwindcss'))) {
    projectInfo.cssFramework = 'tailwind';
  }

  if (response.toLowerCase().includes('next.js') ||
    (extractedFiles['package.json'] && extractedFiles['package.json'].includes('next'))) {
    projectInfo.framework = 'next';
  }

  return { files: extractedFiles, projectInfo };
}

/**
 * Handle the full process of generating and deploying a project
 * @param {string} prompt - User's project description prompt
 * @param {string} uniqueId - Unique ID for this job
 * @param {string} apiProvider - API provider to use ('openai' or 'gemini')
 * @returns {Promise<void>}
 */
async function processGenerateAndDeploy(prompt, uniqueId, apiProvider) {
  const outputDir = path.join(OUTPUT_DIR_BASE, uniqueId);
  const job = deploymentJobs.get(uniqueId);

  try {
    // Update job status
    job.status = 'generating';
    job.lastUpdated = Date.now();

    let files, projectInfo;

    if (apiProvider === 'openai') {
      // Use OpenAI Assistant
      const thread = await openai.beta.threads.create();

      const enhancedPrompt = `
I need you to generate code for a web application based on the following requirements:

${prompt}

Please provide ALL the code files needed for this project including:
1. React components (.jsx/.tsx files)
2. CSS/Styling files
3. Configuration files (like package.json, vite.config.js, etc.)
4. Any utility functions or hooks
5. Main entry points (index.js, App.js, etc.)

For each code file, please use the format:
\`\`\`language
// filename: path/to/filename.ext
// Code content here
\`\`\`

DO NOT try to execute npm or npx commands - just provide the code files.
I will handle the setup and installation myself.
`;

      await openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: enhancedPrompt
      });

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: ASSISTANT_ID
      });

      const completedRun = await pollForRunCompletion(thread.id, run.id);

      if (completedRun.status !== 'completed') {
        throw new Error(`Assistant Run failed: ${completedRun.status}`);
      }

      const result = await extractCodeFromAssistantResponse(thread.id);
      files = result.files;
      projectInfo = result.projectInfo;
    } else {
      // Use Gemini
      const result = await generateCodeWithGemini(prompt);
      files = result.files;
      projectInfo = result.projectInfo;
    }

    if (Object.keys(files).length === 0) {
      throw new Error('No code files found in API response');
    }

    // Update job status
    job.status = 'scaffolding';
    job.lastUpdated = Date.now();

    // Step 6: Create scaffolded project
    console.log('Creating scaffolded project...');
    await createScaffoldedProject(outputDir, projectInfo);

    // Step 7: Add generated code to the project
    console.log('Adding generated code to project...');
    await addGeneratedCodeToProject(outputDir, files);

    // Step 8: List the project files
    const projectFiles = listFilesRecursively(outputDir, outputDir);

    // Step 9: Read content of small text files
    const fileContents = {};
    projectFiles.forEach(file => {
      try {
        const filePath = path.join(outputDir, file);
        const stats = fs.statSync(filePath);

        // Only include small text files (< 1MB)
        if (stats.size < 1024 * 1024 && isTextFile(file)) {
          fileContents[file] = fs.readFileSync(filePath, 'utf8');
        }
      } catch (err) {
        console.error(`Error reading file ${file}: ${err.message}`);
      }
    });

    // Store files and contents in job
    job.files = projectFiles;
    job.fileContents = fileContents;

    // Update job status
    job.status = 'deploying';
    job.lastUpdated = Date.now();

    // Step 10: Deploy to Vercel
    if (VERCEL_TOKEN) {
      console.log('Deploying project to Vercel...');
      const projectName = `ai-project-${uniqueId}`;
      const deployResult = await deployToVercel(outputDir, projectName);

      if (deployResult.success) {
        job.status = 'completed';
        job.deploymentUrl = deployResult.url;
        job.deploymentOutput = deployResult.output;
      } else {
        job.status = 'deployment_failed';
        job.error = deployResult.error;
      }
    } else {
      job.status = 'completed_without_deployment';
      job.error = 'Vercel token not configured. Project generated but not deployed.';
    }

    // Final job update
    job.lastUpdated = Date.now();
    job.completed = true;

  } catch (error) {
    console.error(`Job processing failed: ${error.message}`);
    job.status = 'failed';
    job.error = error.message;
    job.lastUpdated = Date.now();
    job.completed = true;
  }
}

/**
 * POST /generateProject
 * 
 * Accepts a prompt and generates a complete project by:
 * 1. Getting code from the OpenAI Assistant
 * 2. Running scaffolding commands locally
 * 3. Combining the generated code with the scaffolded structure
 * 4. Deploying the project to Vercel
 */
app.post('/generateProject', async (req, res) => {
  const { prompt, apiProvider = 'openai' } = req.body;

  // Validate request
  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: prompt'
    });
  }

  if (apiProvider === 'openai' && (!process.env.OPENAI_API_KEY || !ASSISTANT_ID)) {
    return res.status(400).json({
      success: false,
      error: 'OpenAI configuration is missing'
    });
  }

  if (apiProvider === 'gemini' && !process.env.GOOGLE_API_KEY) {
    return res.status(400).json({
      success: false,
      error: 'Google API configuration is missing'
    });
  }

  // Generate a unique ID for this request
  const uniqueId = crypto.randomBytes(8).toString('hex');
  const outputDir = path.join(OUTPUT_DIR_BASE, uniqueId);

  // Create the output directory
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Processing prompt: ${prompt}`);
  console.log(`Using API provider: ${apiProvider}`);
  console.log(`Output directory: ${outputDir}`);

  // Create job entry
  const job = {
    id: uniqueId,
    prompt,
    outputDir: `generated_projects/${uniqueId}`,
    status: 'pending', // pending, generating, scaffolding, deploying, completed, failed
    created: Date.now(),
    lastUpdated: Date.now(),
    completed: false,
    apiProvider
  };

  // Store the job
  deploymentJobs.set(uniqueId, job);

  // Start processing in the background
  processGenerateAndDeploy(prompt, uniqueId, apiProvider).catch(error => {
    console.error(`Background job error: ${error.message}`);
    const job = deploymentJobs.get(uniqueId);
    if (job) {
      job.status = 'failed';
      job.error = error.message;
      job.lastUpdated = Date.now();
      job.completed = true;
    }
  });

  // Return immediate response with job ID
  return res.json({
    success: true,
    message: 'Project generation and deployment started',
    jobId: uniqueId,
    status: 'pending',
    statusUrl: `/getDeploymentStatus?jobId=${uniqueId}`
  });
});

/**
 * GET /getDeploymentStatus
 * 
 * Returns the current status of a deployment job
 */
app.get('/getDeploymentStatus', (req, res) => {
  const { jobId } = req.query;

  if (!jobId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: jobId'
    });
  }

  const job = deploymentJobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job not found'
    });
  }

  // Return different fields based on status
  const response = {
    success: true,
    jobId: job.id,
    status: job.status,
    created: job.created,
    lastUpdated: job.lastUpdated
  };

  // Add additional fields based on status
  if (job.completed) {
    response.outputDir = job.outputDir;

    if (job.error) {
      response.error = job.error;
    }

    if (job.files) {
      response.files = job.files;
    }

    if (job.deploymentUrl) {
      response.deploymentUrl = job.deploymentUrl;
    }

    // Only include fileContents if specifically requested
    if (req.query.includeFiles === 'true' && job.fileContents) {
      response.fileContents = job.fileContents;
    }
  }

  return res.json(response);
});

// Start the server
app.listen(port, () => {
  console.log(`Assistant Coder server listening on port ${port}`);
  console.log(`API endpoint: http://localhost:${port}/generateProject`);
  if (VERCEL_TOKEN) {
    console.log('Vercel deployment is enabled');
  } else {
    console.log('WARNING: Vercel deployment is disabled (VERCEL_TOKEN not set)');
  }
});