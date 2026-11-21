/**
 * 会议号的**显示层唯一取词处**：三方号怎么分组、拿不到号时屏幕上写哪一句。
 *
 * 为什么要有这一处：`AllMeetingsView` 与 `DashboardView` 各抄了一份逐字相同的"正好 8 位才对半"，
 * `PreMeetingView` 又另立一套三位一组 —— 同一个号三种长相。而三方文档
 * (`platform/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API.md` 开头那节) 写明号是 **6–12 位**，
 * "只在正好 8 位时分"等于 9–12 位直接糊成一串数字上桌。
 *
 * 入会页那个大号三位分组是刻意的排版，**不吃本文件**，也别反过来把它并进来。
 */

/** 拿不到号时上桌的那句（契约 §6.5：三方目录里挂不到会的孤立录像只能是空串，不拿别的键冒充）。
 * 会议域那侧空号说的是另一件事（预约已记录但还没同步到三方），措辞仍是「尚未同步」，两者别混用。 */
export const MEETING_NO_ABSENT = '原会议已查不到'

/** 上面那句的悬浮说明。两处界面共用这一份，别各写一遍（界面上不许出现厂商/接口名，见 check:copy） */
export const MEETING_NO_ABSENT_HINT = '这场会已经不在了，所以取不到它的会议号'

/** 4 位一组；长度不能整除 4 或不足 8 位时原样（6 位切成 `1234 56` 比整串更难读） */
export function formatMeetingNo(no: string): string {
  const digits = String(no ?? '').replace(/\D/g, '')
  if (digits.length >= 8 && digits.length % 4 === 0) return digits.replace(/(\d{4})(?=\d)/g, '$1 ')
  return no
}
