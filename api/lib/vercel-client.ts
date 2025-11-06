import { Octokit } from '@octokit/rest';

export interface VercelDeployment {
  url: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
}

/**
 * Wait for a Vercel preview deployment to be ready for a given PR
 * Parses Vercel bot's comment to get the preview URL
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
      // Get PR info to get the head ref
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });

      // Get deployments for this PR's branch from the Environments section
      const { data: deployments } = await octokit.repos.listDeployments({
        owner,
        repo,
        ref: pr.head.ref,
        per_page: 10
      });

      console.log(`📋 Found ${deployments.length} deployment(s) for PR #${prNumber} (attempt ${attempts + 1})`);

      if (deployments.length === 0) {
        console.log('⚠️ No deployments found. Vercel may not be integrated or deployment not created yet.');
      }

      // Look for deployments by vercel[bot]
      for (const deployment of deployments) {
        console.log(`\n🔍 Deployment ID: ${deployment.id}`);
        console.log(`   Environment: "${deployment.environment}"`);
        console.log(`   Task: "${deployment.task}"`);
        console.log(`   Created by: ${deployment.creator?.login || 'unknown'}`);
        console.log(`   Ref: ${deployment.ref}`);

        // Get deployment statuses to check if it's ready
        const { data: statuses } = await octokit.repos.listDeploymentStatuses({
          owner,
          repo,
          deployment_id: deployment.id,
          per_page: 10
        });

        console.log(`   Found ${statuses.length} status(es) for this deployment:`);

        statuses.forEach((status, idx) => {
          console.log(`   Status ${idx + 1}: state="${status.state}", env_url="${status.environment_url || 'none'}", description="${status.description || 'none'}"`);
        });

        // Look for successful deployment with environment URL
        const successStatus = statuses.find(s => s.state === 'success');

        if (successStatus && successStatus.environment_url) {
          const envUrl = successStatus.environment_url;
          const envName = deployment.environment?.toLowerCase() || '';

          // Skip storybook deployments
          if (envName.includes('storybook') || envUrl.toLowerCase().includes('storybook')) {
            console.log(`⏭️  Skipping Storybook deployment: ${envUrl}`);
            continue;
          }

          // Found a successful non-storybook preview deployment!
          console.log(`✅ Found ready deployment in environment: ${deployment.environment}`);
          console.log(`🔗 Preview URL: ${envUrl}`);

          // Small safety delay to ensure deployment is fully ready
          console.log('⏳ Waiting 5s to ensure deployment is serving traffic...');
          await new Promise(resolve => setTimeout(resolve, 5000));

          return envUrl;
        }
      }

      attempts++;
      console.log(`⏳ Attempt ${attempts}/${maxAttempts} - No ready deployment found yet, waiting 10s...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (error) {
      console.error('Error checking deployment status:', error);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log('❌ Timeout waiting for Vercel deployment to be ready');
  return null;
}
