# API rate limits

## Limits per plan

The Starter plan allows 60 API requests per minute, Business allows 600 requests per minute, and Enterprise allows 3,000 requests per minute. Limits apply per workspace, not per API key.

## Handling 429 responses

When the limit is exceeded the API returns HTTP 429 Too Many Requests with a Retry-After header in seconds. Clients should wait at least that long and retry with exponential backoff and jitter.

## Raising limits

Enterprise customers can request a higher limit through their account manager. Limits are not raised for Starter or Business plans; upgrading the plan is the supported path.
