/**
 * GitHub API Client
 * Handles all interactions with GitHub (diffs, validation, etc.)
 */

import type { GitHubValidationResult } from './types.js';

// Get diff comparison between two branches
export async function getCodeDiff(
  octokit: any,
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string
): Promise<string> {
  try {
    // Get comparison between branches
    const { data } = await octokit.repos.compareCommits({
      owner,
      repo,
      base: baseBranch,
      head: headBranch
    });

    if (data.files && data.files.length === 0) {
      return 'No changes detected between branches.';
    }

    let diffSummary = `# Code Changes Summary\n\n`;
    diffSummary += `**Total files changed:** ${data.files?.length || 0}\n`;
    diffSummary += `**Total additions:** +${data.total_commits ? data.ahead_by : 0} commits\n\n`;

    // Format each file's changes
    if (data.files) {
      for (const file of data.files) {
        diffSummary += `\n## File: ${file.filename}\n`;
        diffSummary += `**Status:** ${file.status}\n`;
        diffSummary += `**Changes:** +${file.additions} -${file.deletions}\n\n`;

        if (file.patch) {
          diffSummary += `\`\`\`diff\n${file.patch}\n\`\`\`\n`;
        }
      }
    }

    return diffSummary;
  } catch (error: any) {
    console.error('Error getting diff:', error);
    throw new Error(`Failed to get code diff: ${error.message}`);
  }
}

// Trigger GitHub Actions workflow and wait for results
export async function runGitHubValidation(
  octokit: any,
  owner: string,
  repo: string,
  branch: string,
  validationType: 'build' | 'test' | 'both'
): Promise<GitHubValidationResult> {
  try {
    console.log(`🔨 Triggering GitHub Actions validation (${validationType}) for ${branch}...`);

    // Trigger the workflow
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: 'claude-validate.yml',
      ref: branch,
      inputs: {
        branch: branch,
        test_type: validationType
      }
    });

    console.log('✓ Workflow triggered, waiting for run to start...');

    // Wait a bit for the workflow to start
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Poll for the workflow run
    let workflowRun: any = null;
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max (5 seconds * 60)

    while (attempts < maxAttempts) {
      // Get recent workflow runs for this branch
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: 'claude-validate.yml',
        branch: branch,
        per_page: 5
      });

      // Find the most recent run
      const recentRun = runs.workflow_runs[0];

      if (recentRun && recentRun.status !== 'queued' && recentRun.status !== 'in_progress') {
        workflowRun = recentRun;
        break;
      }

      // Still running, wait and check again
      console.log(`⏳ Workflow status: ${recentRun?.status || 'starting'}...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    if (!workflowRun) {
      return {
        success: false,
        summary: 'Validation timeout',
        details: 'GitHub Actions workflow did not complete within 5 minutes. This might indicate the workflow is not set up correctly or the build/tests are taking too long.'
      };
    }

    // Check the result
    const success = workflowRun.conclusion === 'success';
    const conclusion = workflowRun.conclusion || 'unknown';

    console.log(`✓ Workflow completed with conclusion: ${conclusion}`);

    // Get job logs for more details
    let details = `Workflow URL: ${workflowRun.html_url}\n\n`;

    try {
      const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: workflowRun.id
      });

      for (const job of jobs.jobs) {
        details += `\n**${job.name}**: ${job.conclusion}\n`;
        if (job.conclusion === 'failure') {
          // Try to get step details
          for (const step of job.steps || []) {
            if (step.conclusion === 'failure') {
              details += `  ❌ Failed step: ${step.name}\n`;
            }
          }
        }
      }
    } catch (logError) {
      console.error('Could not fetch job details:', logError);
      details += '\n(Could not fetch detailed job logs)';
    }

    const summary = success
      ? `✅ Validation passed! Your code compiles and ${validationType === 'test' ? 'tests pass' : validationType === 'build' ? 'builds successfully' : 'builds and tests pass'}.`
      : `❌ Validation failed. The ${validationType} process encountered errors. Please review the logs and fix the issues.`;

    return { success, summary, details };

  } catch (error: any) {
    console.error('Error running GitHub validation:', error);

    // Check if it's a 404 - workflow file doesn't exist
    if (error.status === 404) {
      return {
        success: false,
        summary: 'Validation workflow not found',
        details: `The GitHub Actions workflow file "claude-validate.yml" was not found in the repository. This repository needs to have the workflow set up first. You can proceed without validation, but the code may not actually work. Error: ${error.message}`
      };
    }

    return {
      success: false,
      summary: 'Validation error',
      details: `Failed to run validation: ${error.message}`
    };
  }
}
