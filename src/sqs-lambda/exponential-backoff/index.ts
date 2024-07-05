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
	if (
		!process.env.MAX_RETRIES ||
		!process.env.MAIN_QUEUE_URL ||
		!process.env.DLQ_URL
	) {
		throw new Error(
			'Environment variables MAX_RETRIES, DLQ_URL or MAIN_QUEUE_URL missing'
		)
	}

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
