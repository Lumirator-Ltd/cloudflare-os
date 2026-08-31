import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'
import './i18n/config'

type ActionDecision = 'approve' | 'deny'

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const { t } = useTranslation()
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      toasts.add({
        title: t(decision === 'approve'
          ? 'workspace.approval.resolveFailedApprove'
          : 'workspace.approval.resolveFailedDeny'),
        variant: 'error',
      })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts, t])
}
