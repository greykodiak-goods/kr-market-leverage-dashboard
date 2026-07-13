// KST market session helpers. KRX regular session: 09:00–15:30 KST, Mon–Fri.

export function nowKst(): Date {
  // Convert current time to KST regardless of local timezone.
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  return new Date(utcMs + 9 * 3600000)
}

export interface MarketStatus {
  isOpen: boolean
  label: string
}

export function krxStatus(): MarketStatus {
  const k = nowKst()
  const day = k.getDay()
  const minutes = k.getHours() * 60 + k.getMinutes()
  const open = 9 * 60
  const close = 15 * 60 + 30
  const weekday = day >= 1 && day <= 5
  const isOpen = weekday && minutes >= open && minutes < close
  return { isOpen, label: isOpen ? '장중' : weekday ? '장마감' : '휴장(주말)' }
}
