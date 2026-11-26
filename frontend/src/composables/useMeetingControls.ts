import { ElMessage, ElMessageBox } from 'element-plus'
import { kickParticipant, muteAllParticipants } from '@/api/meeting'

export interface MeetingControlsOptions {
  meetingId: () => number
  onForcedMute: () => Promise<void>
  onKickedOut: (reason: string) => Promise<void>
}

/**
 * 主持人会控（全员静音 / 踢出参会人）与被控端指令响应。
 * 从 InMeetingView.vue 抽离，保持主页面结构清晰。
 */
export function useMeetingControls(opts: MeetingControlsOptions) {
  async function handleMuteAll() {
    const id = opts.meetingId()
    if (!id) return
    try {
      await ElMessageBox.confirm('确定将除你之外的所有参会人设为静音？', '全员静音', {
        type: 'warning',
        confirmButtonText: '确定静音',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
    try {
      await muteAllParticipants(id)
      ElMessage.success('已向全体参会人发送静音指令')
    } catch {
      /* 错误由 request 拦截器统一提示 */
    }
  }

  async function handleKick(participantId: string, name: string) {
    const id = opts.meetingId()
    if (!id || !participantId) return
    try {
      await ElMessageBox.confirm(`确定将「${name || '该成员'}」移出当前会议？`, '移出参会人', {
        type: 'warning',
        confirmButtonText: '确定移出',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
    try {
      await kickParticipant(id, participantId)
      ElMessage.success(`已将「${name || '该成员'}」移出会议`)
    } catch {
      /* 错误由 request 拦截器统一提示 */
    }
  }

  async function applyMuteAllEvent() {
    ElMessage.info('主持人已开启全员静音')
    await opts.onForcedMute()
  }

  async function applyKickedEvent(reason: string) {
    ElMessage.warning(reason || '你已被主持人移出会议')
    await opts.onKickedOut(reason || '你已被主持人移出会议')
  }

  return {
    handleMuteAll,
    handleKick,
    applyMuteAllEvent,
    applyKickedEvent,
  }
}
