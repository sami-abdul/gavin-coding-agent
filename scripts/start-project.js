#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get project ID from command line arguments
const projectId = process.argv[2];

if (!projectId) {
    console.error('Error: Please provide a project ID');
    console.log('Usage: npm run start-project <project-id>');
    process.exit(1);
}

const projectPath = path.join(__dirname, '..', 'generated_projects', projectId);

// Check if project directory exists
if (!fs.existsSync(projectPath)) {
    console.error(`Error: Project directory not found: ${projectPath}`);
    process.exit(1);
}

// Check if package.json exists
const packageJsonPath = path.join(projectPath, 'package.json');
if (!fs.existsSync(packageJsonPath)) {
    console.error(`Error: package.json not found in project directory`);
    process.exit(1);
}

console.log(`🚀 Starting project: ${projectId}`);
console.log(`📂 Project path: ${projectPath}`);

// Install dependencies if node_modules doesn't exist
const nodeModulesPath = path.join(projectPath, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
    console.log('📦 Installing dependencies...');
    const install = spawn('npm', ['install'], {
        cwd: projectPath,
        stdio: 'inherit',
        shell: true
    });

    install.on('close', (code) => {
        if (code !== 0) {
            console.error(`Error: npm install failed with code ${code}`);
            process.exit(1);
        }
        startDevServer();
    });
} else {
    startDevServer();
}

function startDevServer() {
    console.log('🚀 Starting development server...');

    // Start the development server
    const devServer = spawn('npm', ['run', 'dev'], {
        cwd: projectPath,
        stdio: 'inherit',
        shell: true
    });

    // Handle process termination
    process.on('SIGINT', () => {
        console.log('\nStopping development server...');
        devServer.kill();
        process.exit();
    });
} 