/**
 * test-claude-api.js - Test client specifically for the Claude provider in Assistant Coder API
 */

const fetch = require('node-fetch');
const readline = require('readline');

// Assuming the server runs on the default port
const API_URL = 'http://localhost:3001/generateProject';
const STATUS_URL = 'http://localhost:3001/getDeploymentStatus';
const POLLING_INTERVAL = 5000; // 5 seconds

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Poll for job status until complete (copied from test-assistant-api.js)
 * @param {string} jobId - The ID of the job to check
 * @returns {Promise<Object>} - The final job data
 */
async function pollJobStatus(jobId) {
  let isComplete = false;
  let attempts = 0;
  let lastStatus = '';

  while (!isComplete) {
    try {
      const response = await fetch(`${STATUS_URL}?jobId=${jobId}`);
      const data = await response.json();

      if (!data.success) {
        // Check if job not found initially, maybe a slight delay
        if (data.error === 'Job not found' && attempts < 3) {
             process.stdout.write('?'); // Indicate waiting for job appearance
        } else {
            throw new Error(`Status check failed: ${data.error || 'Unknown error'}`);
        }
      } else {
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
          if (['completed', 'failed', 'deployment_failed', 'completed_without_deployment'].includes(data.status)) {
            return data;
          }
      }
    } catch (fetchError) {
         console.error(`\nPolling Error: ${fetchError.message}`);
         // Decide whether to retry or fail after network errors
         if (attempts > 5) { // Stop after several network errors
             throw new Error(`Polling failed after multiple network errors: ${fetchError.message}`);
         }
         process.stdout.write('x'); // Indicate network error
    }


    // Prevent infinite loops
    attempts++;
    // Increased timeout to 15 minutes for potentially longer Claude generation
    if (attempts > 180) { // 15 minutes max (180 * 5 seconds) 
      throw new Error('Polling timed out after 15 minutes');
    }

    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
  }
}

/**
 * Get emoji for the current status (copied from test-assistant-api.js)
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
 * Test function that sends a request to the server using Claude and displays the response
 */
async function testClaudeApi(customPrompt) {
  try {
    // Use provided prompt or default to a simple example
    const prompt = customPrompt || 'Create a simple React app with Vite that displays "Hello Claude!"';
    const apiProvider = 'claude'; // Hardcode the provider

    console.log('\n🚀 Testing the Assistant Coder API (Claude Provider Only)...');
    console.log(`\n📝 Sending prompt: "${prompt}"`);
    console.log(`\n🤖 Using API provider: ${apiProvider}`);

    const startTime = Date.now();

    // Step 1: Initialize the job
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, apiProvider })
    });

    const initData = await response.json();

    if (!response.ok || !initData.success) {
      console.log('\n❌ Error starting job:');
      console.error(initData.error || `Server responded with status ${response.status}`);
      return;
    }

    console.log(`\n🆔 Job ID: ${initData.jobId}`);
    console.log('\n⏳ Starting project generation and deployment via Claude...');
    console.log('This may take several minutes. Status will update as the process progresses.');

    // Step 2: Poll for job completion
    const finalData = await pollJobStatus(initData.jobId);
    const elapsedMinutes = ((Date.now() - startTime) / 60000).toFixed(1);

    // Step 3: Display the final result (logic copied and adapted from test-assistant-api.js)
    if (finalData.status === 'completed') {
      console.log(`\n\n✅ Project generation and deployment completed in ${elapsedMinutes} minutes!`);
      if (finalData.deploymentUrl) {
        console.log('\n🌐 LIVE DEPLOYMENT:');
        console.log(`   ${finalData.deploymentUrl}`);
      }
      console.log(`\n📂 Local output directory: ${finalData.outputDir}`);

      // Get file contents if needed for display
      const fileDetailsResponse = await fetch(`${STATUS_URL}?jobId=${initData.jobId}&includeFiles=true`);
      const fileData = await fileDetailsResponse.json();

      if (fileData.success && fileData.files && fileData.files.length > 0) {
        console.log(`\n📄 Generated files (${fileData.files.length}):`);
        const filesByDirectory = {};
        fileData.files.forEach(file => {
          const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';
          filesByDirectory[dir] = filesByDirectory[dir] || [];
          filesByDirectory[dir].push(file);
        });
        Object.keys(filesByDirectory).sort().forEach(dir => {
          console.log(`\n  📁 ${dir || 'Root'}:`);
          filesByDirectory[dir].sort().forEach(file => {
            const fileName = file.includes('/') ? file.substring(file.lastIndexOf('/') + 1) : file;
            console.log(`    - ${fileName}`);
            if (fileData.fileContents && fileData.fileContents[file]) {
              const previewContent = fileData.fileContents[file].slice(0, 100).replace(/\n/g, ' ') + '...';
              console.log(`      Preview: ${previewContent}`);
            }
          });
        });
      }
      console.log('\n📋 Next Steps:');
      console.log(`  1. Visit your live deployment: ${finalData.deploymentUrl || '(Deployment unavailable)'}`);
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
    console.log('\n❌ Operation Failed:');
    console.error(error.message);
  }
}

// If run directly, prompt for input and run the test
if (require.main === module) {
  rl.question('\n🤖 Enter your project prompt for Claude (or press Enter for default): ', async (answer) => {
    const prompt = answer.trim();
    await testClaudeApi(prompt);
    rl.close();
  });
}

// Export for potential future use
module.exports = { testClaudeApi }; 