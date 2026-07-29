import { ApplicationExtensionManifestSchema } from '@agent-comm/application-spec'
import managerWorkersConformance from '../../../applications/manager-workers/spec/conformance.json' with {
  type: 'json',
}
import managerWorkersEvents from '../../../applications/manager-workers/spec/events.schema.json' with {
  type: 'json',
}
import requestResponseConformance from '../../../applications/request-response/spec/conformance.json' with {
  type: 'json',
}
import requestResponseEvents from '../../../applications/request-response/spec/events.schema.json' with {
  type: 'json',
}

const requestResponse = ApplicationExtensionManifestSchema.parse({
  schemaVersion: '1',
  uri: 'https://agentcomm.dev/community/request-response/v1',
  name: 'Request and response',
  version: '1.0.0',
  description: 'A minimal portable request, response, failure, and cancellation protocol.',
  license: 'Apache-2.0',
  baseProtocol: 'a2a/1.0',
  mediaTypes: ['application/json'],
  documentation: 'https://agentcomm.dev/community/request-response/v1/',
  conformanceFixtures: 'https://agentcomm.dev/community/request-response/v1/conformance.json',
  compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
  eventSchemas: {
    'request.created': {
      uri: 'https://agentcomm.dev/community/request-response/v1/events.schema.json#/$defs/request_created',
    },
    'response.created': {
      uri: 'https://agentcomm.dev/community/request-response/v1/events.schema.json#/$defs/response_created',
    },
    'request.failed': {
      uri: 'https://agentcomm.dev/community/request-response/v1/events.schema.json#/$defs/request_failed',
    },
    'request.cancelled': {
      uri: 'https://agentcomm.dev/community/request-response/v1/events.schema.json#/$defs/request_cancelled',
    },
  },
})

const managerWorkers = ApplicationExtensionManifestSchema.parse({
  schemaVersion: '1',
  uri: 'https://agentcomm.dev/community/manager-workers/v1',
  name: 'Manager and workers',
  version: '1.0.0',
  description:
    'Coordinates assignment, progress, suspension, completion, and review across a manager and workers.',
  license: 'Apache-2.0',
  baseProtocol: 'a2a/1.0',
  mediaTypes: ['application/json'],
  documentation: 'https://agentcomm.dev/community/manager-workers/v1/',
  conformanceFixtures: 'https://agentcomm.dev/community/manager-workers/v1/conformance.json',
  compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
  eventSchemas: Object.fromEntries(
    [
      'team.started',
      'worker.registered',
      'task.requested',
      'task.assigned',
      'task.progress',
      'task.input-required',
      'task.authorization-required',
      'task.completed',
      'task.failed',
      'review.requested',
      'review.changes-requested',
      'review.approved',
    ].map((eventType) => [
      eventType,
      {
        uri: `https://agentcomm.dev/community/manager-workers/v1/events.schema.json#/$defs/${
          {
            'team.started': 'teamStarted',
            'worker.registered': 'workerRegistered',
            'task.requested': 'taskRequested',
            'task.assigned': 'taskAssigned',
            'task.progress': 'taskProgress',
            'task.input-required': 'taskSuspended',
            'task.authorization-required': 'taskSuspended',
            'task.completed': 'taskCompleted',
            'task.failed': 'taskFailed',
            'review.requested': 'review',
            'review.changes-requested': 'review',
            'review.approved': 'review',
          }[eventType] ?? eventType
        }`,
      },
    ]),
  ),
})

const manifests = new Map([
  ['request-response/1.0.0', requestResponse],
  ['manager-workers/1.0.0', managerWorkers],
])

export function applicationRegistry(origin: string): {
  schemaVersion: 1
  applications: {
    uri: string
    name: string
    version: string
    description: string
    manifestUrl: string
    publisher: string
  }[]
} {
  return {
    schemaVersion: 1,
    applications: [
      {
        uri: requestResponse.uri,
        name: requestResponse.name,
        version: requestResponse.version,
        description: requestResponse.description,
        manifestUrl: `${origin}/api/public/applications/request-response/1.0.0/manifest`,
        publisher: 'AgentComm contributors',
      },
      {
        uri: managerWorkers.uri,
        name: managerWorkers.name,
        version: managerWorkers.version,
        description: managerWorkers.description,
        manifestUrl: `${origin}/api/public/applications/manager-workers/1.0.0/manifest`,
        publisher: 'AgentComm contributors',
      },
    ],
  }
}

export function applicationManifest(name: string, version: string, origin?: string): unknown | undefined {
  const manifest = manifests.get(`${name}/${version}`)
  if (!manifest || !origin) return manifest
  const base = `${origin.replace(/\/$/, '')}/api/public/applications/${name}/${version}`
  return {
    ...manifest,
    conformanceFixtures: `${base}/conformance.json`,
    eventSchemas: Object.fromEntries(
      Object.entries(manifest.eventSchemas).map(([eventType, definition]) => [
        eventType,
        {
          ...definition,
          uri: `${base}/events.schema.json${definition.uri.slice(definition.uri.indexOf('#'))}`,
        },
      ]),
    ),
  }
}

export function applicationAsset(
  name: string,
  version: string,
  asset: 'events.schema.json' | 'conformance.json',
): unknown | undefined {
  const key = `${name}/${version}`
  if (key === 'request-response/1.0.0') {
    return asset === 'events.schema.json' ? requestResponseEvents : requestResponseConformance
  }
  if (key === 'manager-workers/1.0.0') {
    return asset === 'events.schema.json' ? managerWorkersEvents : managerWorkersConformance
  }
  return undefined
}
