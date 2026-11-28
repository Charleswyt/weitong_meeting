import { get, post } from '@/utils/request'

export interface FeedbackSummary {
  likeCount: number
  liked: boolean
}

export interface FeedbackScore {
  id: string
  label: string
  score: number
}

export function getFeedbackSummary() {
  return get<FeedbackSummary>('/api/v1/feedback/summary', { silent: true })
}

export function likeApp() {
  return post<FeedbackSummary>('/api/v1/feedback/like')
}

export function submitFeedback(scores: FeedbackScore[], content: string) {
  return post('/api/v1/feedback/submit', { scores, content })
}
