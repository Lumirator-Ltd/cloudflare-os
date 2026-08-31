import { Select, type PortalContainer } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'
import { useTranslation } from 'react-i18next'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  const { t } = useTranslation()
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label={t('gatekeepers.agentForm.model')}
        description={t('gatekeepers.modal.aiModelDescription')}
      >
        <Select
          aria-label={t('models.selectModel')}
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder={t('models.selectModel')}
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
