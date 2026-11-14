/**
 * One assistant text block's markdown — the SAME component on both sides of the
 * streaming/settled boundary (user report 2026-11-13, step 2).
 *
 * 为什么要抽这一层：流式尾段和它落地后的段，此前是两套组件链（StreamingText
 * → StreamingMarkdown → XMarkdown，对 MessageGroup → FileRefChip → XMarkdown）。
 * 上层 key 对齐（步骤一）只让「行」不被卸载，组件类型一变，React 仍会把整棵
 * markdown 子树丢掉重建：图片重新加载、代码重新高亮、长文重新排版，最后一段
 * 文字在落地的瞬间还要重排一次。现在两侧都是
 * AssistantMarkdown → MarkdownOnce → XMarkdown，落地只是 `live` 这个 props
 * 从对象变成 undefined，React 原地更新，子树不换。
 *
 * 节流的账：每个 tick 整段重解析，成本随答案长度长（probe-chat-stream-perf 实测
 * 20KB 答案 9.4→15.7ms/tick，占 markdown 管线约一半渲染 CPU）。所以 XMarkdown
 * 看到的快照最多每 STREAM_PARSE_MIN_INTERVAL 前进一次，而真正省下来的是
 * MarkdownOnce 的 memo——快照没前进就不进 XMarkdown，解析连同 DOM diff 一起跳过。
 * 落地那一帧 `live` 变空，走的是完整原文，节流不会留下截断的尾巴。
 */
import React, { useRef } from 'react'
import { XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { CodeBlock } from './CodeBlock'
import { LocalImage } from './LocalImage'
import { StreamingCaret } from './StreamingCaret'
import { createTextThrottle, STREAM_PARSE_MIN_INTERVAL } from './stream-throttle'

/** x-markdown's streaming mode for the live tail. `hasNextChunk` holds an
 *  unclosed token back until it closes — half a `**` or a `[text](` no longer
 *  flashes as raw syntax between refreshes; `enableAnimation` fades in each
 *  refresh's new text per block (the throttle sets the chunk size, the default
 *  200ms fade overlaps the 150ms interval; motion.tsx's reduced-motion rule
 *  covers the keyframe). Module constants because XMarkdown memoizes on the
 *  object's identity — minting one per render would re-parse on every tick. */
type StreamingOption = NonNullable<XMarkdownProps['streaming']>
const STREAMING_MD: StreamingOption = { hasNextChunk: true, enableAnimation: true }
/** The caret at the end of the live text: the transcript's own glyph, which
 *  the foot StreamingCursor stops drawing while this tail exists. x-markdown
 *  injects it after the last text token, so an empty `shown` draws none. */
function StreamingTail(): React.ReactElement {
  return <StreamingCaret style={{ marginLeft: 2 }} />
}
const STREAMING_MD_TAIL: StreamingOption = { ...STREAMING_MD, tail: { component: StreamingTail } }

/** The parse boundary. Memoized on the FROZEN snapshot: the live text changes
 *  every tick, but `shown` only advances at STREAM_PARSE_MIN_INTERVAL, so
 *  between advances this skips the render entirely — and XMarkdown's parse
 *  with it. That skip is where the throttle's saving lives (a same-content
 *  re-render would re-parse anyway). `streaming` is in the comparison because
 *  the commit flips it to undefined and that one change MUST reach XMarkdown. */
const MarkdownOnce = React.memo(
  function MarkdownOnce({ shown, streaming }: { shown: string; streaming?: StreamingOption }): React.ReactElement {
    return (
      <XMarkdown
        content={shown}
        streaming={streaming}
        // img rides along on BOTH sides: the settled path always had LocalImage
        // (local files and screenshots in an answer) and the live path did not —
        // unifying the two chains without it would strip that renderer the
        // moment a paragraph lands.
        components={{ code: CodeBlock, img: LocalImage }}
        config={{ extensions: Latex() }}
      />
    )
  },
  (a, b) => a.shown === b.shown && a.streaming === b.streaming,
)

export function AssistantMarkdown({
  text,
  live,
  tail = false,
}: {
  text: string
  /** The round is still streaming this text. Its presence is the ONLY difference
   *  between the live tail and the settled paragraph — everything below renders
   *  the same element either way, which is what keeps the subtree alive. */
  live?: { toolsStarted?: boolean }
  /** This block is where the live caret rides (the last text block with text,
   *  and the round has not moved on to its tool call). Ignored when settled. */
  tail?: boolean
}): React.ReactElement {
  // Per-block throttle, one component instance per text block now that both
  // sides render this: feed() is O(1) and idempotent for the shown text, so
  // calling it every tick costs nothing — what it gates is the parse below.
  // toolsStarted force-advances the snapshot: the tick that mounts the tool
  // card after this text must render the sentence COMPLETE, not one interval
  // behind (2026-10-28 report). During the tool-args phase the text no longer
  // changes, so the forced feed is an idempotent no-op there.
  const throttleRef = useRef<ReturnType<typeof createTextThrottle> | null>(null)

  if (!live) return <MarkdownOnce shown={text} />

  if (!throttleRef.current) throttleRef.current = createTextThrottle(STREAM_PARSE_MIN_INTERVAL)
  // eslint-disable-next-line react-hooks/purity -- the stream throttle's arrival clock: feed() decides how much of the accumulated text may show now
  const shown = throttleRef.current.feed(text, performance.now(), live.toolsStarted === true)
  return <MarkdownOnce shown={shown} streaming={tail ? STREAMING_MD_TAIL : STREAMING_MD} />
}
