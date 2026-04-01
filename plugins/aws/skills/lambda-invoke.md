---
name: lambda-invoke
description: Invoke AWS Lambda functions with payload and view execution logs.
triggers:
  - "invoke lambda"
  - "run lambda"
  - "lambda function"
---

# Lambda Invoke

Invoke AWS Lambda functions and view results.

## Usage

When asked to invoke a Lambda function:

1. Identify the function name and region
2. Prepare the invocation payload
3. Invoke and display the response and execution metrics

## Parameters

- `function`: Lambda function name or ARN (required)
- `payload`: JSON payload to send
- `region`: AWS region (default: from config)
- `log-type`: Include execution log (default: Tail)
- `invocation-type`: RequestResponse, Event, or DryRun

## Example

```bash
aws lambda invoke --function-name my-function --payload '{"key": "value"}' output.json
```
