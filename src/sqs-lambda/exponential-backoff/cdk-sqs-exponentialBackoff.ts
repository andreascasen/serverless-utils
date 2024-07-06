import { StackProps, Duration, Stack, App } from 'aws-cdk-lib'
import * as Lambda from 'aws-cdk-lib/aws-lambda'
import * as SQS from 'aws-cdk-lib/aws-sqs'
import * as LambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources'

type CustomProps = StackProps & {
	exponentialBackoffSteps: Duration[]
}

export class ExponentialBackoffStack extends Stack {
	constructor(scope: App, id: string, props: CustomProps) {
		super(scope, id, props)

		const eventHandler = new Lambda.Function(this, 'eventHandler', {
			memorySize: 256,
			runtime: Lambda.Runtime.NODEJS_LATEST,
			description: 'This function handles the events in the queues',
			code: Lambda.Code.fromAsset('src'),
			handler: 'eventHandler.handler',
		})

		const operatorQueue = new SQS.Queue(this, 'operatorQueue', {
			queueName: 'operatorQueue',
		})

		const queues: SQS.Queue[] = []
		props.exponentialBackoffSteps.reverse().forEach((duration, index) => {
			queues.push(
				this.createHandlerSqsEventSource(
					{
						name: `step${props.exponentialBackoffSteps.length - index}`,
						dlq: index === 0 ? operatorQueue : queues[index - 1],
						delay: duration,
					},
					eventHandler
				)
			)
		})
	}

	createHandlerSqsEventSource(
		{
			name,
			dlq,
			delay,
		}: { name: string; dlq: SQS.Queue; delay?: Duration | undefined },
		eventHandler: Lambda.Function
	): SQS.Queue {
		const queue = new SQS.Queue(this, name, {
			queueName: name,
			deliveryDelay: delay || Duration.seconds(0),
			deadLetterQueue: {
				queue: dlq,
				maxReceiveCount: 1,
			},
		})

		queue.grantConsumeMessages(eventHandler)
		eventHandler.addEventSource(
			new LambdaEventSources.SqsEventSource(queue, {
				batchSize: 1,
			})
		)
		return queue
	}
}
