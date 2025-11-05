import { test, expect } from '@playwright/test';

test.describe('Jira Webhook Endpoint', () => {
  test('should respond to webhook endpoint', async ({ request }) => {
    const response = await request.get('/api/jira-webhook');

    // Expect GET to return 405 (Method Not Allowed) since webhook expects POST
    expect(response.status()).toBe(405);
  });

  test('should reject POST without proper headers', async ({ request }) => {
    const response = await request.post('/api/jira-webhook', {
      data: {
        issue: {
          key: 'TEST-123',
        }
      }
    });

    // Should reject without proper webhook secret
    expect([400, 401, 403]).toContain(response.status());
  });
});

test.describe('Health Check', () => {
  test('application should be accessible', async ({ page }) => {
    // Try to access the root - Vercel projects usually have some response
    const response = await page.goto('/');

    // Should at least get some response (even if 404)
    expect(response).toBeTruthy();
    expect(response?.status()).toBeLessThan(500);
  });
});
