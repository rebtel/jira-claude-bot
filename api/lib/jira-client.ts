/**
 * Jira API Client
 * Handles all interactions with Jira (comments, transitions, etc.)
 */

// Helper function to add comments to Jira tickets
export async function addJiraComment(issueKey: string, message: string): Promise<void> {
  try {
    const auth = Buffer.from(
      `${process.env.JIRA_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
    ).toString('base64');

    const response = await fetch(
      `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/comment`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: {
            type: 'doc',
            version: 1,
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: message }]
            }]
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to add Jira comment: ${response.status} - ${errorText}`);
      throw new Error(`Failed to add Jira comment: ${response.status}`);
    }

    console.log(`✓ Added comment to ${issueKey}`);
  } catch (error) {
    console.error('Error adding Jira comment:', error);
    throw error;
  }
}

// Helper function to transition Jira ticket status
export async function transitionJiraTicket(issueKey: string, targetStatus: string): Promise<void> {
  try {
    const auth = Buffer.from(
      `${process.env.JIRA_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
    ).toString('base64');

    // Get available transitions for this issue
    const transitionsResponse = await fetch(
      `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        }
      }
    );

    if (!transitionsResponse.ok) {
      const errorText = await transitionsResponse.text();
      console.error(`Failed to get transitions: ${transitionsResponse.status} - ${errorText}`);
      throw new Error(`Failed to get transitions: ${transitionsResponse.status}`);
    }

    const transitionsData = await transitionsResponse.json();

    // Find the transition that leads to the target status
    const transition = transitionsData.transitions.find((t: any) =>
      t.to.name === targetStatus || t.name === targetStatus
    );

    if (!transition) {
      console.warn(`⚠️ Transition to "${targetStatus}" not found. Available transitions:`,
        transitionsData.transitions.map((t: any) => ({ id: t.id, name: t.name, to: t.to.name }))
      );
      throw new Error(`Transition to "${targetStatus}" not available for this issue`);
    }

    console.log(`Found transition: ${transition.name} (ID: ${transition.id}) -> ${transition.to.name}`);

    // Execute the transition
    const transitionResponse = await fetch(
      `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/transitions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transition: {
            id: transition.id
          }
        })
      }
    );

    if (!transitionResponse.ok) {
      const errorText = await transitionResponse.text();
      console.error(`Failed to transition ticket: ${transitionResponse.status} - ${errorText}`);
      throw new Error(`Failed to transition ticket: ${transitionResponse.status}`);
    }

    console.log(`✓ Transitioned ${issueKey} to "${targetStatus}"`);
  } catch (error) {
    console.error('Error transitioning Jira ticket:', error);
    throw error;
  }
}
