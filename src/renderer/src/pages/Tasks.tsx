import { useEffect, useState } from 'react'
import PlannerDialog, { type PlannerDialogTarget } from '../components/PlannerDialog'
import {
  CalendarIcon,
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  RestoreIcon,
  TrashIcon,
  XIcon
} from '../components/icons'
import { useAppStore } from '../store/appStore'
import {
  addDays,
  formatDayLabel,
  formatTime,
  isTaskDone,
  todayISO,
  type RoutineItem,
  type RoutineStep,
  type TaskItem
} from '../planner'

function metaLine(task: TaskItem): string {
  const parts: string[] = []
  if (task.due) {
    parts.push(formatDayLabel(task.due))
    if (task.time) parts.push(formatTime(task.time))
  }
  if (task.location.trim()) parts.push(task.location.trim())
  return parts.join(' · ')
}

function TaskRow({
  task,
  onEdit
}: {
  task: TaskItem
  onEdit: (task: TaskItem) => void
}): React.JSX.Element {
  const toggleTask = useAppStore((state) => state.toggleTask)
  const deleteTask = useAppStore((state) => state.deleteTask)
  const openDay = useAppStore((state) => state.openDay)
  const meta = metaLine(task)
  const done = isTaskDone(task)
  return (
    <div className={`task-row${done ? ' is-done' : ''}`}>
      <button
        type="button"
        className="task-check"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={() => toggleTask(task.id)}
      >
        <span className="task-check__box" />
      </button>
      <button type="button" className="task-main" onClick={() => onEdit(task)}>
        <span className="task-title">{task.title.trim() || 'Untitled'}</span>
        {meta && <span className="task-meta">{meta}</span>}
        {task.notes.trim() && <span className="task-desc">{task.notes.trim()}</span>}
      </button>
      {task.due && (
        <button
          type="button"
          className="icon-btn"
          title={`View ${formatDayLabel(task.due)} on calendar`}
          aria-label={`View on calendar`}
          onClick={() => openDay(task.due as string)}
        >
          <CalendarIcon size={15} />
        </button>
      )}
      <button
        type="button"
        className="icon-btn icon-btn--danger"
        title="Delete task"
        aria-label={`Delete ${task.title || 'Untitled'}`}
        onClick={() => deleteTask(task.id)}
      >
        <TrashIcon size={15} />
      </button>
    </div>
  )
}

function StepRow({ routineId, step }: { routineId: string; step: RoutineStep }): React.JSX.Element {
  const toggleRoutineStep = useAppStore((state) => state.toggleRoutineStep)
  const renameRoutineStep = useAppStore((state) => state.renameRoutineStep)
  const removeRoutineStep = useAppStore((state) => state.removeRoutineStep)
  // Local draft commits on blur/Enter; step titles only change here, so no
  // sync effect is needed (avoids a set-state-in-effect cascade).
  const [draft, setDraft] = useState(step.title)

  const commit = (): void => {
    if (draft.trim() && draft !== step.title) renameRoutineStep(routineId, step.id, draft)
    else setDraft(step.title)
  }

  return (
    <div className={`routine-step${step.done ? ' is-done' : ''}`}>
      <button
        type="button"
        className="task-check"
        role="checkbox"
        aria-checked={step.done}
        aria-label={step.done ? `Reopen ${step.title}` : `Complete ${step.title}`}
        onClick={() => toggleRoutineStep(routineId, step.id)}
      >
        <span className="task-check__box" />
      </button>
      <input
        className="routine-step__input"
        value={draft}
        spellCheck={false}
        aria-label="Step title"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          if (event.key === 'Escape') setDraft(step.title)
        }}
      />
      <button
        type="button"
        className="icon-btn icon-btn--danger routine-step__remove"
        title={`Remove ${step.title || 'step'}`}
        aria-label="Remove step"
        onClick={() => removeRoutineStep(routineId, step.id)}
      >
        <XIcon size={13} />
      </button>
    </div>
  )
}

function RoutineRow({
  routine,
  expanded,
  onToggleExpand
}: {
  routine: RoutineItem
  expanded: boolean
  onToggleExpand: () => void
}): React.JSX.Element {
  const renameRoutine = useAppStore((state) => state.renameRoutine)
  const deleteRoutine = useAppStore((state) => state.deleteRoutine)
  const addRoutineStep = useAppStore((state) => state.addRoutineStep)
  const toggleRoutineAll = useAppStore((state) => state.toggleRoutineAll)
  const resetRoutine = useAppStore((state) => state.resetRoutine)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState(routine.title)
  const [stepDraft, setStepDraft] = useState('')

  const total = routine.steps.length
  const done = routine.steps.filter((step) => step.done).length
  const allDone = total > 0 && done === total

  const commitRename = (): void => {
    setRenaming(false)
    if (renameDraft.trim() && renameDraft !== routine.title) {
      renameRoutine(routine.id, renameDraft)
    }
  }

  const commitStep = (): void => {
    if (!stepDraft.trim()) return
    addRoutineStep(routine.id, stepDraft)
    setStepDraft('')
  }

  return (
    <div className={`routine${allDone ? ' is-done' : ''}`}>
      <div className="routine__head">
        <button
          type="button"
          className={`routine__chevron${expanded ? ' is-open' : ''}`}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${routine.title}` : `Expand ${routine.title}`}
          onClick={onToggleExpand}
        >
          <ChevronDownIcon size={14} />
        </button>
        <button
          type="button"
          className="task-check"
          role="checkbox"
          aria-checked={allDone}
          aria-label={allDone ? `Reopen ${routine.title}` : `Complete ${routine.title}`}
          title={allDone ? 'Mark all steps open' : 'Mark all steps done'}
          onClick={() => toggleRoutineAll(routine.id)}
        >
          <span className="task-check__box" />
        </button>
        {renaming ? (
          <input
            className="routine__rename"
            autoFocus
            value={renameDraft}
            spellCheck={false}
            aria-label="Routine name"
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') {
                setRenameDraft(routine.title)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <button type="button" className="routine__title" onClick={onToggleExpand}>
            {routine.title.trim() || 'Untitled routine'}
          </button>
        )}
        <span className="routine__progress" title={`${done} of ${total} steps done`}>
          {total === 0 ? 'no steps' : `${done}/${total}`}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={`Rename ${routine.title || 'routine'}`}
          aria-label="Rename routine"
          onClick={() => {
            setRenameDraft(routine.title)
            setRenaming(true)
          }}
        >
          <PencilIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Reset steps for today"
          aria-label="Reset routine steps"
          onClick={() => resetRoutine(routine.id)}
        >
          <RestoreIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          title="Delete routine"
          aria-label={`Delete ${routine.title || 'routine'}`}
          onClick={() => deleteRoutine(routine.id)}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      {total > 0 && (
        <div
          className="routine__bar"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      {expanded && (
        <div className="routine__steps">
          {routine.steps.map((step) => (
            <StepRow key={step.id} routineId={routine.id} step={step} />
          ))}
          <div className="routine__add">
            <PlusIcon size={13} />
            <input
              className="routine__add-input"
              value={stepDraft}
              spellCheck={false}
              placeholder="Add a step…"
              aria-label="New step title"
              onChange={(event) => setStepDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitStep()
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function dayLabel(due: string, today: string, tomorrow: string): string {
  if (due === today) return 'Today'
  if (due === tomorrow) return 'Tomorrow'
  return formatDayLabel(due)
}

function Tasks(): React.JSX.Element {
  const tasks = useAppStore((state) => state.tasks)
  const routines = useAppStore((state) => state.routines)
  const plannerReady = useAppStore((state) => state.plannerReady)
  const plannerError = useAppStore((state) => state.plannerError)
  const addRoutine = useAppStore((state) => state.addRoutine)
  const ensureRoutinesToday = useAppStore((state) => state.ensureRoutinesToday)
  const clearCompletedTasks = useAppStore((state) => state.clearCompletedTasks)
  const taskFilter = useAppStore((state) => state.taskFilter)
  const [dialog, setDialog] = useState<PlannerDialogTarget | null>(null)
  const [expandedRoutines, setExpandedRoutines] = useState<Set<string>>(new Set())

  // Fresh day, fresh checks — even if the app stayed open overnight.
  useEffect(() => {
    ensureRoutinesToday()
  }, [ensureRoutinesToday])

  const today = todayISO()
  const tomorrow = addDays(today, 1)

  const openTasks = tasks.filter((t) => !isTaskDone(t))
  const allDone = tasks.filter((t) => isTaskDone(t))
  const open =
    taskFilter === 'today'
      ? openTasks.filter((t) => t.due === today)
      : taskFilter === 'overdue'
        ? openTasks.filter((t) => t.due !== null && t.due < today)
        : taskFilter === 'completed'
          ? []
          : openTasks
  const overdue = open.filter((t) => t.due !== null && t.due < today)
  // Chronological timeline: dated tasks first by due date + time.
  const dated = open
    .filter((t) => t.due !== null && t.due >= today)
    .sort((a, b) => ((a.due ?? '') + (a.time ?? '') < (b.due ?? '') + (b.time ?? '') ? -1 : 1))
  const general = open.filter((t) => t.due === null).sort((a, b) => b.updatedAt - a.updatedAt)
  const done =
    taskFilter === 'all' || taskFilter === 'completed'
      ? [...allDone].sort((a, b) => b.updatedAt - a.updatedAt)
      : []

  // Preserve chronological order while grouping dated tasks by day.
  const dayGroups: { due: string; items: TaskItem[] }[] = []
  for (const task of dated) {
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.due === task.due) last.items.push(task)
    else dayGroups.push({ due: task.due as string, items: [task] })
  }

  const edit = (item: TaskItem): void => setDialog({ mode: 'edit-task', item })

  return (
    <main className="task">
      <div className="task__inner">
        <header className="task__header">
          <div>
            <h1 className="task__title">Tasks</h1>
            <p className="task__subtitle">
              {open.length === 0
                ? 'All clear.'
                : `${open.length} open · tasks created on the calendar land here`}
            </p>
          </div>
          <div className="task__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                const id = addRoutine('Untitled routine')
                setExpandedRoutines((prev) => new Set(prev).add(id))
              }}
            >
              <PlusIcon size={15} />
              New routine
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setDialog({ mode: 'create', kind: 'task', date: today })}
            >
              <PlusIcon size={15} />
              New task
            </button>
          </div>
        </header>

        {plannerError && (
          <p className="cal__error" role="alert">
            {plannerError}
          </p>
        )}
        {!plannerReady ? (
          <p className="cal__empty">Loading tasks…</p>
        ) : (
          <>
            {routines.length > 0 && (
              <section className="task-group task-group--routines" aria-label="Daily routines">
                <h2 className="task-group__title">Routines</h2>
                <p className="task-group__hint">Daily checklists — steps reset every morning.</p>
                {routines.map((routine) => (
                  <RoutineRow
                    key={routine.id}
                    routine={routine}
                    expanded={expandedRoutines.has(routine.id)}
                    onToggleExpand={() =>
                      setExpandedRoutines((prev) => {
                        const next = new Set(prev)
                        if (next.has(routine.id)) next.delete(routine.id)
                        else next.add(routine.id)
                        return next
                      })
                    }
                  />
                ))}
              </section>
            )}

            {(overdue.length > 0 || dayGroups.length > 0) && (
              <section className="task-timeline" aria-label="Task timeline">
                {overdue.length > 0 && (
                  <div className="task-day task-day--overdue">
                    <h2 className="task-day__title">Overdue</h2>
                    {overdue.map((task) => (
                      <TaskRow key={task.id} task={task} onEdit={edit} />
                    ))}
                  </div>
                )}
                {dayGroups.map((group) => (
                  <div key={group.due} className="task-day">
                    <h2 className="task-day__title">{dayLabel(group.due, today, tomorrow)}</h2>
                    {group.items.map((task) => (
                      <TaskRow key={task.id} task={task} onEdit={edit} />
                    ))}
                  </div>
                ))}
              </section>
            )}

            {general.length > 0 && (
              <section className="task-group task-group--general" aria-label="General tasks">
                <h2 className="task-group__title">General</h2>
                <p className="task-group__hint">No due date — anytime tasks.</p>
                {general.map((task) => (
                  <TaskRow key={task.id} task={task} onEdit={edit} />
                ))}
              </section>
            )}

            {done.length > 0 && (
              <section className="task-group" aria-label="Completed tasks">
                <div className="task-group__head">
                  <h2 className="task-group__title">Done</h2>
                  <button
                    type="button"
                    className="btn btn--ghost task-group__clear"
                    title="Delete all finished tasks now"
                    onClick={() => clearCompletedTasks()}
                  >
                    Clear finished
                  </button>
                </div>
                {done.map((task) => (
                  <TaskRow key={task.id} task={task} onEdit={edit} />
                ))}
              </section>
            )}
          </>
        )}

        {dialog && <PlannerDialog target={dialog} onClose={() => setDialog(null)} />}
      </div>
    </main>
  )
}

export default Tasks
