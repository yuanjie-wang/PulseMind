// ── API policy (A-M2) ──
// Negotiation between the manifest and the live backend descriptor: members
// the backend doesn't implement are HIDDEN — not error stubs — so docs and
// callable surface always match. Pure logic.

import type { BackendDescriptor } from './protocol'
import type { BrowserApiManifest, ManifestMember } from './manifest'

export function memberSupported(member: ManifestMember, descriptor: BackendDescriptor): boolean {
  if (member.unsupportedByDefaultIn?.includes(descriptor.type)) return false
  if (member.requiresCapabilities) {
    const have = new Set([...descriptor.capabilities.browser, ...descriptor.capabilities.tab])
    if (!member.requiresCapabilities.every((c) => have.has(c))) return false
  }
  return true
}

/** Members of one object visible on the current backend. An object hidden at
 *  the object level (unsupportedByDefaultIn) has NO visible members. */
export function effectiveMembers(
  manifest: BrowserApiManifest,
  objectName: string,
  descriptor: BackendDescriptor,
): Array<[string, ManifestMember]> {
  const object = manifest.objects[objectName]
  if (!object) return []
  if (object.unsupportedByDefaultIn?.includes(descriptor.type)) return []
  return Object.entries(object.members).filter(([, member]) => memberSupported(member, descriptor))
}

/** Whole-object visibility: an object whose every member is hidden is itself
 *  hidden (e.g. recording on managed). */
export function objectVisible(manifest: BrowserApiManifest, objectName: string, descriptor: BackendDescriptor): boolean {
  const object = manifest.objects[objectName]
  if (!object) return false
  if (object.unsupportedByDefaultIn?.includes(descriptor.type)) return false
  return effectiveMembers(manifest, objectName, descriptor).length > 0
}
