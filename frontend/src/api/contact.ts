import { del, get, post, put } from '@/utils/request'

export interface ContactVo {
  userId: number
  username: string
  displayName: string
  avatar: string
  /** 脱敏后的邮箱，如 zh***@126.com */
  email: string
  /** 脱敏后的手机号 */
  mobile: string
  hasEmail: boolean
  accountType: string
  remark: string
  addedAt: string
  isContact: boolean
}

export interface ContactInviteResult {
  invited: number
  emailQueued: number
  noEmail: string[]
  skipped: number
}

export function listContacts() {
  return get<ContactVo[]>('/api/v1/contacts/')
}

export function searchUsers(keyword: string) {
  return get<ContactVo[]>('/api/v1/contacts/search', { params: { keyword } })
}

export function addContact(userId: number, remark = '') {
  return post('/api/v1/contacts/', { userId, remark })
}

export function removeContact(userId: number) {
  return del(`/api/v1/contacts/${userId}`)
}

export function updateContactRemark(userId: number, remark: string) {
  return put(`/api/v1/contacts/${userId}/remark`, { remark })
}

export function inviteContacts(meetingId: number, userIds: number[], joinUrl = '') {
  return post<ContactInviteResult>('/api/v1/contacts/invite', { meetingId, userIds, joinUrl })
}

export function contactLabel(c: Pick<ContactVo, 'remark' | 'displayName' | 'username'>): string {
  return c.remark || c.displayName || c.username
}
