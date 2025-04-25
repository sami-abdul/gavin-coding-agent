/**
 * test-assistant-api.js - Test client for the Assistant Coder API
 */

const fetch = require('node-fetch');
const readline = require('readline');

const API_URL = 'http://localhost:3001/generateProject';
const STATUS_URL = 'http://localhost:3001/getDeploymentStatus';
const POLLING_INTERVAL = 5000; // 5 seconds

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Poll for job status until complete
 * @param {string} jobId - The ID of the job to check
 * @returns {Promise<Object>} - The final job data
 */
async function pollJobStatus(jobId) {
  let isComplete = false;
  let attempts = 0;
  let lastStatus = '';
  
  while (!isComplete) {
    // Get job status
    const response = await fetch(`${STATUS_URL}?jobId=${jobId}`);
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`Status check failed: ${data.error}`);
    }
    
    // Update status display if changed
    if (data.status !== lastStatus) {
      const statusEmoji = getStatusEmoji(data.status);
      console.log(`\n${statusEmoji} Status: ${data.status.toUpperCase()}`);
      lastStatus = data.status;
      
      // Show error if failed
      if (data.status.includes('failed') && data.error) {
        console.log(`\n❌ Error: ${data.error}`);
      }
    } else {
      // Just print a dot to show we're still alive
      process.stdout.write('.');
    }
    
    // Check if the job is complete (success or failure)
    if (data.status === 'completed' || 
        data.status === 'failed' ||
        data.status === 'deployment_failed' || 
        data.status === 'completed_without_deployment') {
      return data;
    }
    
    // Prevent infinite loops
    attempts++;
    if (attempts > 60) { // 5 minutes max (60 * 5 seconds)
      throw new Error('Polling timed out after 5 minutes');
    }
    
    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
  }
}

/**
 * Get emoji for the current status
 */
function getStatusEmoji(status) {
  const statusMap = {
    'pending': '⏳',
    'generating': '🧠',
    'scaffolding': '🏗️',
    'deploying': '🚀',
    'completed': '✅',
    'completed_without_deployment': '⚠️',
    'deployment_failed': '❌',
    'failed': '❌'
  };
  return statusMap[status] || '🔄';
}

/**
 * Test function that sends a request to the server and displays the response
 */
async function testApi(customPrompt) {
  try {
    // Use provided prompt or default to a simple example
    const prompt = customPrompt || 'Create a simple React app with Vite that displays a counter with increment/decrement buttons and save count to local storage';
    
    console.log('\n🚀 Testing the Assistant Coder API...');
    console.log(`\n📝 Sending prompt: "${prompt}"`);
    
    const startTime = Date.now();
    
    // Step 1: Initialize the job
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });
    
    const initData = await response.json();
    
    if (!initData.success) {
      console.log('\n❌ Error starting job:');
      console.error(initData.error);
      return;
    }
    
    console.log(`\n🆔 Job ID: ${initData.jobId}`);
    console.log('\n⏳ Starting project generation and deployment...');
    console.log('This may take several minutes. Status will update as the process progresses.');
    
    // Step 2: Poll for job completion
    const finalData = await pollJobStatus(initData.jobId);
    const elapsedMinutes = ((Date.now() - startTime) / 60000).toFixed(1);
    
    // Step 3: Display the final result
    if (finalData.status === 'completed') {
      console.log(`\n\n✅ Project generation and deployment completed in ${elapsedMinutes} minutes!`);
      
      // Display deployment URL prominently
      if (finalData.deploymentUrl) {
        console.log('\n🌐 LIVE DEPLOYMENT:');
        console.log(`   ${finalData.deploymentUrl}`);
      }
      
      console.log(`\n📂 Local output directory: ${finalData.outputDir}`);
      
      // Only get file contents if needed for display
      const fileDetailsResponse = await fetch(`${STATUS_URL}?jobId=${initData.jobId}&includeFiles=true`);
      const fileData = await fileDetailsResponse.json();
      
      if (fileData.files && fileData.files.length > 0) {
        console.log(`\n📄 Generated files (${fileData.files.length}):`);
        
        // Group files by directory for better display
        const filesByDirectory = {};
        fileData.files.forEach(file => {
          const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';
          if (!filesByDirectory[dir]) {
            filesByDirectory[dir] = [];
          }
          filesByDirectory[dir].push(file);
        });
        
        // Display files grouped by directory
        Object.keys(filesByDirectory).sort().forEach(dir => {
          if (dir === '') {
            console.log('\n  📁 Root:');
          } else {
            console.log(`\n  📁 ${dir}:`);
          }
          
          filesByDirectory[dir].sort().forEach(file => {
            const fileName = file.includes('/') ? file.substring(file.lastIndexOf('/') + 1) : file;
            console.log(`    - ${fileName}`);
            
            // Print preview of text files
            if (fileData.fileContents && fileData.fileContents[file]) {
              const previewContent = fileData.fileContents[file].slice(0, 100).replace(/\n/g, ' ') + '...';
              console.log(`      Preview: ${previewContent}`);
            }
          });
        });
      }
      
      console.log('\n📋 Next Steps:');
      console.log('  1. Visit your live deployment:');
      console.log(`     ${finalData.deploymentUrl || '(Deployment unavailable)'}`);
      console.log('  2. To work with the code locally:');
      console.log(`     cd ${finalData.outputDir}`);
      console.log('     npm install');
      console.log('     npm run dev');
    } else {
      console.log(`\n\n❌ Project generation ${finalData.status} after ${elapsedMinutes} minutes`);
      console.log(`\n📂 Local output directory: ${finalData.outputDir} (may be incomplete)`);
      
      if (finalData.error) {
        console.log('\n🚨 Error details:');
        console.log(`   ${finalData.error}`);
      }
    }
  } catch (error) {
    console.log('\n❌ Error:');
    console.error('Failed to complete the operation:', error.message);
  }
}

// If run directly, prompt for input and run the test
if (require.main === module) {
  rl.question('\n🤖 Enter your project prompt (or press Enter for default): ', async (answer) => {
    await testApi(answer.trim());
    rl.close();
  });
}

module.exports = { testApi }; 