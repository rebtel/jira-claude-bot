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

      // Check for deployment status
      const { data: statuses } = await octokit.repos.listCommitStatusesForRef({
        owner,
        repo,
        ref: headSha
      });

      // Look for Vercel deployment status
      const vercelStatus = statuses.find(s =>
        s.context?.includes('vercel') ||
        s.context?.includes('deployment')
      );

      if (vercelStatus && vercelStatus.state === 'success' && vercelStatus.target_url) {
        console.log(`✅ Vercel deployment ready: ${vercelStatus.target_url}`);
        return vercelStatus.target_url;
      }

      // Also check deployment API
      const { data: deployments } = await octokit.repos.listDeployments({
        owner,
        repo,
        ref: pr.head.ref,
        per_page: 5
      });

      for (const deployment of deployments) {
        const { data: deploymentStatuses } = await octokit.repos.listDeploymentStatuses({
          owner,
          repo,
          deployment_id: deployment.id
        });

        const successStatus = deploymentStatuses.find(s => s.state === 'success');
        if (successStatus && successStatus.environment_url) {
          console.log(`✅ Vercel deployment ready: ${successStatus.environment_url}`);
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
