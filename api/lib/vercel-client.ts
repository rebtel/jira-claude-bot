import { Octokit } from '@octokit/rest';

export interface VercelDeployment {
  url: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
}

/**
 * Wait for a Vercel preview deployment to be ready for a given PR
 */
export async function waitForVercelDeployment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  maxWaitMinutes: number = 5
): Promise<string | null> {
  const maxAttempts = (maxWaitMinutes * 60) / 10; // Check every 10 seconds
  let attempts = 0;

  console.log(`⏳ Waiting for Vercel preview deployment for PR #${prNumber}...`);

  while (attempts < maxAttempts) {
    try {
      // Get the latest commit status for the PR
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });

      const headSha = pr.head.sha;

      // Check for deployment status (legacy status API)
      const { data: statuses } = await octokit.repos.listCommitStatusesForRef({
        owner,
        repo,
        ref: headSha
      });

      if (attempts === 0) {
        console.log('📋 Available statuses:', statuses.map(s => ({ context: s.context, state: s.state })));
      }

      // Look for Vercel deployment status
      const vercelStatus = statuses.find(s =>
        s.context?.toLowerCase().includes('vercel') ||
        s.context?.toLowerCase().includes('deployment')
      );

      if (vercelStatus) {
        console.log(`🔍 Found Vercel status: ${vercelStatus.context} - ${vercelStatus.state}`);
        if (vercelStatus.state === 'success' && vercelStatus.target_url) {
          console.log(`✅ Vercel deployment ready: ${vercelStatus.target_url}`);
          return vercelStatus.target_url;
        }
      }

      // Check Checks API (newer GitHub API that Vercel might use)
      const { data: checkRuns } = await octokit.checks.listForRef({
        owner,
        repo,
        ref: headSha
      });

      if (attempts === 0) {
        console.log('📋 Available checks:', checkRuns.check_runs.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion })));
      }

      const vercelCheck = checkRuns.check_runs.find(c =>
        c.name.toLowerCase().includes('vercel') ||
        c.name.toLowerCase().includes('deployment')
      );

      if (vercelCheck) {
        console.log(`🔍 Found Vercel check: ${vercelCheck.name} - ${vercelCheck.status} (${vercelCheck.conclusion})`);
        if (vercelCheck.status === 'completed' && vercelCheck.conclusion === 'success' && vercelCheck.details_url) {
          console.log(`✅ Vercel deployment ready: ${vercelCheck.details_url}`);
          return vercelCheck.details_url;
        }
      }

      // Also check deployment API
      const { data: deployments } = await octokit.repos.listDeployments({
        owner,
        repo,
        ref: pr.head.ref,
        per_page: 5
      });

      if (attempts === 0 && deployments.length > 0) {
        console.log(`📋 Found ${deployments.length} deployment(s)`);
      }

      for (const deployment of deployments) {
        const { data: deploymentStatuses } = await octokit.repos.listDeploymentStatuses({
          owner,
          repo,
          deployment_id: deployment.id
        });

        const successStatus = deploymentStatuses.find(s => s.state === 'success');
        if (successStatus && successStatus.environment_url) {
          console.log(`✅ Vercel deployment ready via Deployments API: ${successStatus.environment_url}`);
          return successStatus.environment_url;
        }
      }

      attempts++;
      console.log(`⏳ Attempt ${attempts}/${maxAttempts} - Deployment not ready yet, waiting 10s...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (error) {
      console.error('Error checking deployment status:', error);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log('❌ Timeout waiting for Vercel deployment');
  return null;
}
