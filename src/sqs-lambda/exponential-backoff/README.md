# SQS & Lambda - Exponential Backoff

I did some digging around to find out how exponential backoff is implemented in Amazon SQS.
After reading a bunch of docs, blogs and repositories, I arrived at the conclusion that there are mainly 2 ways to achieve this.

## 1 - The manual way

Using an AWS Lambda with the SQS dead letter queue as it's event source, you scan the event body for a _retryCount_ value, and based on what this value is the event either:

- gets re-sent to the main queue with an increased _retryCount_ value and a higher **DeliveryDelay** setting.
- has hit the maximum amount of retries, and gets moved to a final dead letter queue (_also referred to as an operator queue_) for manual handling.

This is the approach that demonstrated in this repository, and it is basically a Typescript version of [Jimmy Dahlqvist's implementation](https://serverless-handbook.com/pattern-retries).

Here is the code from [this example's index file](index.ts):

```typescript
import { SQSEvent, Context } from 'aws-lambda'
import {
	SQSClient,
	SendMessageCommandInput,
	SendMessageCommand,
} from '@aws-sdk/client-sqs'

const sqsClient = new SQSClient({ region: 'eu-west-1' })

const delaySecondsPerRetry: Record<string, number> = {
	1: 300, // 5 minutes
	2: 1800, // 30 minutes
	3: 14400, // 4 hours
}

export const handler = async (event: SQSEvent, context: Context) => {
	const body = JSON.parse(event.Records[0].body)
	let payload

	if (!body.metadata) {
		payload = { metadata: { retryCount: 1 }, data: body }
	} else {
		payload = body
		payload.metadata.retryCount++
	}

	if (payload.metadata.retryCount < parseInt(process.env.MAX_RETRIES)) {
		await publishToQueue(
			process.env.MAIN_QUEUE_URL,
			payload,
			delaySecondsPerRetry[payload.metadata.retryCount.toString()]
		)
	} else {
		await publishToQueue(process.env.DLQ_URL, payload)
	}
}

export const publishToQueue = async (
	queueUrl: string,
	event: any,
	delaySeconds = 0
) => {
	const params: SendMessageCommandInput = {
		QueueUrl: queueUrl,
		MessageBody: JSON.stringify(event),
	}

	if (delaySeconds > 0) {
		params.DelaySeconds = delaySeconds
	}

	return await sqsClient.send(new SendMessageCommand(params))
}
```

## 2 - A chain of queues

Another interesting approach I ran into was a mechanism that I would describe as a chain of queues. This is done by setting up a main queue as an event source to your lambda. This main queue then has a dlq with a higher deliveryDelay, which in turn is also an event source of that same lambda. This dlq in turn has its own dlq, with a higher deliveryDelay than the previous one, and so on.

Eventually you get to a "last" dlq that **isn't** an event source to the lambda, but instead acts as your operator queue where events that still fail after X amount of time & retries end up.

Here is a CDK example:

```typescript
import CDK, {
	Duration,
	aws_lambda as Lambda,
	aws_lambda_event_sources,
	aws_sqs,
} from 'aws-cdk-lib'

type CustomProps extends CDK.StackProps {
	exponentialBackoffSteps: CDK.Duration[]
}

export class ExponentialBackoffStack extends CDK.Stack {
	constructor(scope: CDK.App, id: string, props?: CDK.StackProps) {
		super(scope, id, props)

		const eventHandler = new Lambda.Function(this, 'eventHandler', {
			memorySize: 256,
			runtime: Lambda.Runtime.NODEJS_LATEST,
			description: 'This function handles the events in the queues',
			code: Lambda.Code.fromAsset('src'),
			handler: 'eventHandler.handler',
		})

		const operatorQueue = new aws_sqs.Queue(this, 'operatorQueue', {
			queueName: 'operatorQueue',
		})

		const queues: aws_sqs.Queue[] = []
		exponentialBackoffSteps
			.reverse()
			.forEach((duration, index) => {
				queues.push(this.createHandlerSqsEventSource({
					name: `step${exponentialBackoffSteps.lenght - index}`,
					dlq: index === 0 ? operatorQueue : queues[index - 1],
					delay: duration
				}))
			})
	}

	createHandlerSqsEventSource({
		name: string,
		dlq: aws_sqs.Queue,
		delay?: CDK.Duration
	}, eventHandler: aws_lambda.Function): aws_sqs.Queue {
		const queue =  new aws_sqs.Queue(this, name, {
			queueName: name,
			deliveryDelay: delay || CDK.Duration.seconds(0),
			deadLetterQueue: {
				queue: dlq,
				maxReceiveCount: 1,
			},
		})

		queue.grantConsumeMessages(eventHandler)
		eventHandler.addEventSource(
			new aws_lambda_event_sources.SqsEventSource(queue, {
				batchSize: 1,
			})
		)
	}
}
```

Of course, this is not a very scalable approach if you want to have many steps in your exponential back off algorithm, but if all you need are 3 or 4 different retries and time increases, it seems to be a pretty smooth way of letting the SQS service handle this for you entirely, which in the end feels a lot more _serverless_ to me. It also has the added benefit of not having ot manually modify the events as you reinsert them back into the main queue.

---

## Conclusion

While the lambda implementation feels like the cleaner way of doing it from an infrastrcuture point of view, implementing things this way doesn't feel quite as _serverless_ as I'd wish for.

After all, one of the main reasons I love services like SQS, Lambda & SNS is precisely because I don't need to be manually meddling with infrastructure concerns if things get designed correctly.

With that said, I think the "Chain of queues" approach quickly becomes a terrible idea if your backoff algorithm has more than 3 or 4 steps to it. Let's face it, who wants to end up with 10 queues just to solve exponential backoff, right?

After doing some thinking, I feel like the "Chain of queues" approach would be my choice if the backoff algorithm needs 3 or less retries, just for the simplicity of letting SQS handle it for me. Anything past 3 to 4 retries however, and I would definitely go with the lambda implementation.
