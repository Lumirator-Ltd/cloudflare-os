import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'
import { useTranslation } from 'react-i18next'

export default function UserMenu() {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : t('shell.navigation.defaultUserInitial')

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="w-7 h-7 cursor-pointer rounded-full flex items-center justify-center bg-kumo-tint hover:bg-kumo-fill transition-colors overflow-hidden"
            title={t('shell.navigation.openProfileMenu')}
            aria-label={t('shell.navigation.openProfileMenu')}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          {t('shell.navigation.profile')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          {t('shell.navigation.providers')}
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            {t('shell.navigation.admin')}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          {t('shell.navigation.signOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
