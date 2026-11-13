import { useEffect, useState } from 'react'

/** The products this person was limited to when invited (e.g. ManyMotions.org for Sofia and Fritz): they show in every
 *  product list and filter even before a task or note uses them. Empty for admins and members of every product. */
export function useAssignedProducts(): string[] {
  const [list, setList] = useState<string[]>([])
  useEffect(() => { void window.term.workspace.state().then(s => setList([...new Set((s.identity?.companies ?? []).flatMap(c => (c as { products?: string[] | null }).products ?? []))])).catch(() => {}) }, [])
  return list
}
