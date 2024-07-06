import CDK, {
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