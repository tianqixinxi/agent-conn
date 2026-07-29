import {
  type ApplicationExtensionManifest,
  ApplicationExtensionManifestSchema,
} from '@agent-comm/application-spec'
import type {
  ApplicationConsumer,
  ApplicationConsumerResult,
  ApplicationEffect,
  VerifiedApplicationEvent,
} from '@agent-comm/client-sdk'
import { z } from 'zod'

export const MANAGER_WORKERS_EXTENSION_URI = 'https://agentcomm.dev/community/manager-workers/v1' as const
export const MANAGER_WORKERS_VERSION = '1.0.0' as const

export const MANAGER_WORKERS_EVENT_TYPES = [
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
] as const

export type ManagerWorkersEventType = (typeof MANAGER_WORKERS_EVENT_TYPES)[number]

const TaskStatusSchema = z.enum([
  'requested',
  'assigned',
  'in-progress',
  'input-required',
  'authorization-required',
  'completed',
  'failed',
  'changes-requested',
  'approved',
])

export interface ManagerWorkersTask {
  taskId: string
  goal: string
  status: z.infer<typeof TaskStatusSchema>
  assignedTo?: string | undefined
  progress?: number | undefined
  result?: unknown
  error?: string | undefined
  review?: string | undefined
}

export interface ManagerWorkersState {
  manager?: string | undefined
  workers: Record<string, { capabilities: string[]; status: 'available' | 'busy' }>
  tasks: Record<string, ManagerWorkersTask>
}

const TeamStartedSchema = z.object({ manager: z.string().min(1) })
const WorkerRegisteredSchema = z.object({
  worker: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
})
const TaskRequestedSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string().min(1),
  worker: z.string().min(1),
})
const TaskAssignedSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string().min(1),
  worker: z.string().min(1),
})
const TaskProgressSchema = z.object({
  taskId: z.string().min(1),
  progress: z.number().min(0).max(100),
  note: z.string().optional(),
})
const TaskSuspendedSchema = z.object({
  taskId: z.string().min(1),
  prompt: z.string().min(1),
  scope: z.unknown().optional(),
})
const TaskCompletedSchema = z.object({ taskId: z.string().min(1), result: z.unknown() })
const TaskFailedSchema = z.object({ taskId: z.string().min(1), error: z.string().min(1) })
const ReviewSchema = z.object({
  taskId: z.string().min(1),
  reviewer: z.string().min(1).optional(),
  note: z.string().optional(),
})

function eventSchema(eventType: string): z.ZodType {
  switch (eventType) {
    case 'team.started':
      return TeamStartedSchema
    case 'worker.registered':
      return WorkerRegisteredSchema
    case 'task.requested':
      return TaskRequestedSchema
    case 'task.assigned':
      return TaskAssignedSchema
    case 'task.progress':
      return TaskProgressSchema
    case 'task.input-required':
    case 'task.authorization-required':
      return TaskSuspendedSchema
    case 'task.completed':
      return TaskCompletedSchema
    case 'task.failed':
      return TaskFailedSchema
    case 'review.requested':
    case 'review.changes-requested':
    case 'review.approved':
      return ReviewSchema
    default:
      throw new Error(`unsupported manager-workers event: ${eventType}`)
  }
}

const schemaDefinitionByEvent: Record<ManagerWorkersEventType, string> = {
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
}

const eventSchemas = Object.fromEntries(
  MANAGER_WORKERS_EVENT_TYPES.map((eventType) => [
    eventType,
    {
      uri: `${MANAGER_WORKERS_EXTENSION_URI}/events.schema.json#/$defs/${schemaDefinitionByEvent[eventType]}`,
    },
  ]),
)

export const managerWorkersManifest: ApplicationExtensionManifest = ApplicationExtensionManifestSchema.parse({
  schemaVersion: '1',
  uri: MANAGER_WORKERS_EXTENSION_URI,
  name: 'Manager and workers',
  version: MANAGER_WORKERS_VERSION,
  description:
    'Coordinates assignment, progress, suspension, completion, and review across a manager and workers.',
  license: 'Apache-2.0',
  baseProtocol: 'a2a/1.0',
  mediaTypes: ['application/json'],
  documentation: `${MANAGER_WORKERS_EXTENSION_URI}/`,
  conformanceFixtures: `${MANAGER_WORKERS_EXTENSION_URI}/conformance.json`,
  compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
  eventSchemas,
})

function initialState(): ManagerWorkersState {
  return { workers: {}, tasks: {} }
}

function selector(eventType: ManagerWorkersEventType) {
  return {
    uri: MANAGER_WORKERS_EXTENSION_URI,
    version: MANAGER_WORKERS_VERSION,
    eventType,
  }
}

function publish(
  to: string,
  eventType: ManagerWorkersEventType,
  body: unknown,
  contextId: string,
): ApplicationEffect {
  return { type: 'publish', to, selector: selector(eventType), body, contextId }
}

export interface ManagerWorkersConsumerOptions {
  role: 'manager' | 'worker'
  alias: string
  managerAlias?: string | undefined
  autoResult?: unknown
}

/**
 * Reference reducer/client. It is an independent application package and only
 * depends on the public application spec and SDK—not relay, channel, or MCP code.
 */
export function createManagerWorkersConsumer(options: ManagerWorkersConsumerOptions): ApplicationConsumer {
  return {
    id: `manager-workers.${options.role}.${options.alias}`,
    version: MANAGER_WORKERS_VERSION,
    supports: [
      {
        uri: MANAGER_WORKERS_EXTENSION_URI,
        version: MANAGER_WORKERS_VERSION,
        backwardCompatibleFrom: '1.0.0',
      },
    ],
    handle(event, context): ApplicationConsumerResult {
      const body = eventSchema(event.selector.eventType).parse(event.body) as Record<string, unknown>
      const state: ManagerWorkersState = structuredClone(
        (context.state as ManagerWorkersState | undefined) ?? initialState(),
      )
      const effects: ApplicationEffect[] = []
      const taskId = typeof body.taskId === 'string' ? body.taskId : undefined
      const task = taskId ? state.tasks[taskId] : undefined

      switch (event.selector.eventType as ManagerWorkersEventType) {
        case 'team.started': {
          state.manager = String(body.manager)
          break
        }
        case 'worker.registered': {
          state.workers[String(body.worker)] = {
            capabilities: body.capabilities as string[],
            status: 'available',
          }
          break
        }
        case 'task.requested': {
          const requested: ManagerWorkersTask = {
            taskId: String(body.taskId),
            goal: String(body.goal),
            status: 'requested',
            assignedTo: String(body.worker),
          }
          state.tasks[requested.taskId] = requested
          if (options.role === 'manager') {
            requested.status = 'assigned'
            const worker = state.workers[requested.assignedTo ?? '']
            if (worker) worker.status = 'busy'
            effects.push(
              publish(
                requested.assignedTo ?? '',
                'task.assigned',
                {
                  taskId: requested.taskId,
                  goal: requested.goal,
                  worker: requested.assignedTo,
                },
                context.contextId,
              ),
            )
          }
          break
        }
        case 'task.assigned': {
          const assigned: ManagerWorkersTask = {
            taskId: String(body.taskId),
            goal: String(body.goal),
            status: 'assigned',
            assignedTo: String(body.worker),
          }
          state.tasks[assigned.taskId] = assigned
          if (options.role === 'worker' && assigned.assignedTo === options.alias) {
            assigned.status = 'in-progress'
            const manager = options.managerAlias ?? state.manager ?? 'manager'
            effects.push(
              publish(
                manager,
                'task.progress',
                { taskId: assigned.taskId, progress: 50, note: 'work started' },
                context.contextId,
              ),
            )
            if (options.autoResult === undefined) {
              effects.push({
                type: 'request-input',
                prompt: assigned.goal,
                schema: { taskId: assigned.taskId, manager },
              })
              return {
                status: 'handled',
                state,
                taskState: 'input-required',
                effects,
              }
            } else {
              effects.push(
                publish(
                  manager,
                  'task.completed',
                  { taskId: assigned.taskId, result: options.autoResult },
                  context.contextId,
                ),
              )
            }
          }
          break
        }
        case 'task.progress': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'in-progress'
          task.progress = Number(body.progress)
          break
        }
        case 'task.input-required': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'input-required'
          effects.push({ type: 'request-input', prompt: String(body.prompt), schema: body.scope })
          break
        }
        case 'task.authorization-required': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'authorization-required'
          effects.push({
            type: 'request-authorization',
            prompt: String(body.prompt),
            scope: body.scope,
          })
          break
        }
        case 'task.completed': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'completed'
          task.progress = 100
          task.result = body.result
          if (options.role === 'manager') {
            effects.push(
              publish(
                task.assignedTo ?? event.from,
                'review.requested',
                { taskId, reviewer: options.alias, note: 'verify completion' },
                context.contextId,
              ),
            )
          }
          break
        }
        case 'task.failed': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'failed'
          task.error = String(body.error)
          return { status: 'handled', state, taskState: 'failed', effects }
        }
        case 'review.requested': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.review = 'requested'
          if (options.role === 'worker') {
            effects.push(
              publish(
                options.managerAlias ?? event.from,
                'review.approved',
                { taskId, reviewer: options.alias, note: 'result verified' },
                context.contextId,
              ),
            )
            task.status = 'approved'
            return { status: 'handled', state, taskState: 'completed', effects }
          }
          break
        }
        case 'review.changes-requested': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'changes-requested'
          task.review = String(body.note ?? 'changes requested')
          break
        }
        case 'review.approved': {
          if (!task) throw new Error(`task not found: ${taskId}`)
          task.status = 'approved'
          task.review = String(body.note ?? 'approved')
          const worker = task.assignedTo ? state.workers[task.assignedTo] : undefined
          if (worker) worker.status = 'available'
          return {
            status: 'handled',
            state,
            taskState: 'completed',
            effects: [{ type: 'complete', result: task.result }],
          }
        }
      }
      return { status: 'handled', state, taskState: 'active', effects }
    },
    resume(source, outcome, context): ApplicationConsumerResult {
      if (options.role !== 'worker' || source.selector.eventType !== 'task.assigned') {
        return { status: 'ignored', effects: [] }
      }
      const assigned = TaskAssignedSchema.parse(source.body)
      if (assigned.worker !== options.alias) return { status: 'ignored', effects: [] }
      const state: ManagerWorkersState = structuredClone(
        (context.state as ManagerWorkersState | undefined) ?? initialState(),
      )
      const task = state.tasks[assigned.taskId] ?? {
        taskId: assigned.taskId,
        goal: assigned.goal,
        status: 'in-progress' as const,
        assignedTo: assigned.worker,
      }
      state.tasks[assigned.taskId] = task
      const manager = options.managerAlias ?? state.manager ?? source.from
      if (outcome.status === 'failed') {
        task.status = 'failed'
        task.error = outcome.error ?? 'runtime failed'
        return {
          status: 'handled',
          state,
          taskState: 'failed',
          effects: [
            publish(manager, 'task.failed', { taskId: task.taskId, error: task.error }, context.contextId),
          ],
        }
      }
      task.status = 'completed'
      task.progress = 100
      task.result = outcome.result
      return {
        status: 'handled',
        state,
        taskState: 'active',
        effects: [
          publish(
            manager,
            'task.completed',
            { taskId: task.taskId, result: outcome.result },
            context.contextId,
          ),
        ],
      }
    },
  }
}

export function managerWorkersEvent(
  input: Omit<VerifiedApplicationEvent, 'selector'> & { eventType: ManagerWorkersEventType },
): VerifiedApplicationEvent {
  return { ...input, selector: selector(input.eventType) }
}
