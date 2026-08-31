import { Checkbox } from '@cloudflare/kumo'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { RpcStub } from 'capnweb'
import { GatekeeperIcon } from './GatekeeperIcon'
import { WorkshopInput, WorkshopInputArea } from './WorkshopControls'
import type { BlueprintBindingAnnotation, GadgetClient, GatekeeperCreationSpec } from '@gadgets/workshop-shared/api'
import i18n from '../i18n/config'

export type BindingCardData = {
  bindingName: string
  resourceTitle: string
  vendorId?: string
  creationSpec: GatekeeperCreationSpec
  annotation: BlueprintBindingAnnotation
}

export function suggestValueLabel(
  spec: GatekeeperCreationSpec,
  title?: string,
  t: TFunction = i18n.t,
): string {
  const displayTitle = title?.trim()
  if (displayTitle) return t('workspace.connections.blueprint.suggestNamed', { title: displayTitle })
  switch (spec.type) {
    case 'gatekeeper':
      return t('workspace.connections.blueprint.suggestResource')
    case 'aiModel':
      return t('workspace.connections.blueprint.suggestModel')
    case 'agentSpawner':
      return t('workspace.connections.blueprint.suggestAgent')
    case 'ambient':
      return t('workspace.connections.blueprint.suggestAmbient')
  }
}

export function BlueprintBindingCard({
  data,
  onChange,
  autoFocusDescription,
  flat = false,
}: {
  data: BindingCardData
  onChange: (annotation: BlueprintBindingAnnotation) => void
  autoFocusDescription?: boolean
  /** When true, render without the outer card chrome (border, background, divider). */
  flat?: boolean
}) {
  const { t } = useTranslation()
  const { bindingName, resourceTitle, vendorId, creationSpec, annotation } = data
  const titleId = `blueprint-binding-title-${bindingName}`
  const descriptionId = `blueprint-binding-desc-${bindingName}`
  const displayTitle = annotation.title || resourceTitle || bindingName

  const containerClass = flat
    ? 'space-y-3'
    : 'rounded-xl border border-kumo-line bg-kumo-base'
  const headerClass = flat
    ? 'flex items-start gap-3'
    : 'flex items-start gap-3 px-3 pt-3'
  const descriptionWrapperClass = flat ? '' : 'px-3 pt-2'
  const footerClass = flat
    ? 'flex items-center [&_label]:!text-[12px] [&_label]:!leading-4 [&_label]:!tracking-[-0.2px] [&_label]:!font-normal [&_label]:!text-kumo-subtle'
    : 'mt-2 flex items-center border-t border-kumo-line/70 px-3 py-2 [&_label]:!text-[12px] [&_label]:!leading-4 [&_label]:!tracking-[-0.2px] [&_label]:!font-normal [&_label]:!text-kumo-subtle'

  return (
    <div className={containerClass}>
      <div className={headerClass}>
        <GatekeeperIcon vendorId={vendorId} fallbackText={resourceTitle || bindingName} />
        <div className="min-w-0 flex-1">
          <label htmlFor={titleId} className="sr-only">{t('workspace.connections.blueprint.connectionName')}</label>
          <WorkshopInput
            id={titleId}
            aria-label={t('workspace.connections.blueprint.nameFor', { binding: bindingName })}
            value={annotation.title}
            onChange={(e) => onChange({ ...annotation, title: e.target.value })}
            placeholder={t('workspace.connections.blueprint.connectionName')}
            className="!h-8 w-full bg-kumo-base text-[13px] leading-5 font-medium tracking-[-0.25px]"
          />
          <p className="mt-1 text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
            {t('workspace.connections.blueprint.referencedAs', { name: bindingName })}
          </p>
        </div>
      </div>

      <div className={descriptionWrapperClass}>
        <WorkshopInputArea
          id={descriptionId}
          aria-label={t('workspace.connections.blueprint.helpFor', { title: displayTitle })}
          value={annotation.description}
          onChange={(e) => onChange({ ...annotation, description: e.target.value })}
          placeholder={t('workspace.connections.blueprint.helpPlaceholder')}
          rows={2}
          autoFocus={autoFocusDescription}
          className="w-full resize-none"
        />
      </div>

      <div className={footerClass}>
        <Checkbox
          label={suggestValueLabel(creationSpec, resourceTitle, t)}
          checked={annotation.suggestValue ?? false}
          onCheckedChange={(checked) =>
            onChange({ ...annotation, suggestValue: checked === true })
          }
        />
      </div>
    </div>
  )
}

export function defaultAnnotation(): BlueprintBindingAnnotation {
  return { title: '', description: '', suggestValue: false }
}

export async function loadBindingCardData(
  gadget: RpcStub<GadgetClient>,
  meta: { name: string; resourceTitle: string; vendorId?: string },
): Promise<BindingCardData | null> {
  const gk = await gadget.getBinding(meta.name)
  try {
    if (!gk) return null
    const creationSpecP = gk.getCreationSpec()
    const annotationP = gadget.getBlueprintAnnotation(meta.name)
    const [creationSpec, existing] = await Promise.all([creationSpecP, annotationP])
    return {
      bindingName: meta.name,
      resourceTitle: meta.resourceTitle,
      vendorId: meta.vendorId,
      creationSpec,
      annotation: existing ?? { ...defaultAnnotation(), title: meta.resourceTitle || meta.name },
    }
  } finally {
    gk?.[Symbol.dispose]()
  }
}
