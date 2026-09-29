// ── Usage statistics page ──
// Formerly StatisticsDrawer, a standard view since PLAN-0.4.0. Fetches on mount
// (the page unmounts when the user leaves the view, so every visit re-fetches)
// and renders the hourly/daily/monthly stacked token charts.
//
// The charts wear ZCode's usage palette (its `--color-usage-chart` tokens: sky
// leads, teal second, and the dark column swaps in the brighter rungs —
// sky-600→500, teal-600→400 — exactly like its `.dark` overrides). The built-in
// echarts 'dark' theme is deliberately NOT used: it paints its own #100c2a
// background, which showed as three navy blocks on the page's #141414 ground
// while the old near-black/grey series vanished into it. Every colour is set
// explicitly per mode instead, and setOption runs with notMerge on each mode
// change, so a theme toggled with the page open just re-skins the same instance.

import React, { useEffect, useRef, useState } from 'react'
import { Typography, Spin, Empty } from 'antd'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useTranslation } from '../../i18n/useTranslation'
import { useThemeMode } from '../../theme/mode'
import CenteredPage from './CenteredPage'
import type { TokenStats } from '../../types/conversation'

const { Text, Title } = Typography

// 该页只画堆叠柱图（bar + grid/tooltip/legend + canvas）——echarts/core 按需
// 注册把 chunk 从全量 echarts 的 ~1.13MB 砍到实际用到的内核。页面路由本就
// 懒加载，这砍的是「打开统计页」的首开，不是应用启动。
echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

/** ZCode usage-chart-1/2 (sky/teal). Output is the page's lead series. */
const OUTPUT_COLOR = { light: '#0284c7', dark: '#0ea5e9' }
const INPUT_COLOR = { light: '#0d9488', dark: '#2dd4bf' }

/** Chart chrome per mode, resolved to literals — echarts cannot read CSS vars. */
function chartChrome(isDark: boolean) {
  return isDark
    ? {
        axisLabel: '#8c8c8c',
        legend: '#a6a6a6',
        axisLine: 'rgba(255, 255, 255, 0.14)',
        splitLine: 'rgba(255, 255, 255, 0.08)',
        tooltipBg: '#1f1f1f',
        tooltipBorder: 'rgba(255, 255, 255, 0.14)',
        tooltipText: '#f0f0f0',
      }
    : {
        axisLabel: '#999999',
        legend: '#666666',
        axisLine: '#e8e8e8',
        splitLine: '#f0f0f0',
        tooltipBg: '#ffffff',
        tooltipBorder: '#e8e8e8',
        tooltipText: '#262626',
      }
}

/** Headline numbers: 万/亿 for zh, K/M/B otherwise. One decimal, no trailing .0. */
function formatCompact(n: number, locale: string): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10)
  if (locale === 'zh') {
    if (n >= 1e8) return `${trim(n / 1e8)}亿`
    if (n >= 1e4) return `${trim(n / 1e4)}万`
  } else {
    if (n >= 1e9) return `${trim(n / 1e9)}B`
    if (n >= 1e6) return `${trim(n / 1e6)}M`
    if (n >= 1e3) return `${trim(n / 1e3)}K`
  }
  return String(n)
}

function StatisticsPage(): React.ReactElement {
  const { t, locale } = useTranslation()
  const isDark = useThemeMode() === 'dark'
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<TokenStats | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getTokenStats().then((data) => {
      if (cancelled) return
      setStats(data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const hasData =
    stats &&
    (() => {
      for (const h of stats.hourly) if (h.inputTokens > 0 || h.outputTokens > 0) return true
      for (const d of stats.daily) if (d.inputTokens > 0 || d.outputTokens > 0) return true
      for (const m of stats.monthly) if (m.inputTokens > 0 || m.outputTokens > 0) return true
      return false
    })()

  const totalInput = stats ? stats.monthly.reduce((s, m) => s + m.inputTokens, 0) : 0
  const totalOutput = stats ? stats.monthly.reduce((s, m) => s + m.outputTokens, 0) : 0
  const outputColor = isDark ? OUTPUT_COLOR.dark : OUTPUT_COLOR.light
  const inputColor = isDark ? INPUT_COLOR.dark : INPUT_COLOR.light

  return (
    <CenteredPage>
      {loading ? (
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <Spin size="large" />
        </div>
      ) : !hasData ? (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
          <Empty description={<Text type="secondary">{t('statisticsDrawer.noData')}</Text>} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 40, paddingBottom: 24 }}>
          {/* 累计口径说明（PLAN-parallel-experts L14）：token_usage 不随会话删除，
              否则「删了会话数字没变」会一直被当 bug 报回来。 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 48 }}>
              <StatBlock label={t('statisticsDrawer.outputLabel')} value={formatCompact(totalOutput, locale)} dot={outputColor} />
              <StatBlock label={t('statisticsDrawer.inputLabel')} value={formatCompact(totalInput, locale)} dot={inputColor} />
              <StatBlock label={t('statisticsDrawer.totalLabel')} value={formatCompact(totalOutput + totalInput, locale)} dot={null} />
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
              {t('statisticsDrawer.cumulativeNote')}
            </Text>
          </div>
          <ChartSection
            title={t('statisticsDrawer.hourlyTitle')}
            data={stats!.hourly.map((d) => ({
              label: d.time.slice(11, 16),
              input: d.inputTokens,
              output: d.outputTokens,
            }))}
            inputLabel={t('statisticsDrawer.inputLabel')}
            outputLabel={t('statisticsDrawer.outputLabel')}
            isDark={isDark}
          />
          <ChartSection
            title={t('statisticsDrawer.dailyTitle')}
            data={stats!.daily.map((d) => ({
              label: d.date.slice(5),
              input: d.inputTokens,
              output: d.outputTokens,
            }))}
            inputLabel={t('statisticsDrawer.inputLabel')}
            outputLabel={t('statisticsDrawer.outputLabel')}
            isDark={isDark}
          />
          <ChartSection
            title={t('statisticsDrawer.monthlyTitle')}
            data={stats!.monthly.map((d) => ({
              label: d.month,
              input: d.inputTokens,
              output: d.outputTokens,
            }))}
            inputLabel={t('statisticsDrawer.inputLabel')}
            outputLabel={t('statisticsDrawer.outputLabel')}
            isDark={isDark}
          />
        </div>
      )}
    </CenteredPage>
  )
}

/** ZCode's headline style: a small dot-labelled caption over a big baseline
 *  number. `dot: null` is the untyped total (no swatch). */
function StatBlock({ label, value, dot }: { label: string; value: string; dot: string | null }): React.ReactElement {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--pm-text-muted)', marginBottom: 6 }}>
        {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.25, color: 'var(--pm-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

// --- Chart Section Sub-component (echarts) ---

interface ChartSectionProps {
  title: string
  data: Array<{ label: string; input: number; output: number }>
  inputLabel: string
  outputLabel: string
  isDark: boolean
}

function ChartSection({ title, data, inputLabel, outputLabel, isDark }: ChartSectionProps): React.ReactElement {
  const chartRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<echarts.EChartsType | null>(null)

  useEffect(() => {
    if (!chartRef.current) return
    // No theme argument: the instance stays themeless for its whole life and
    // every colour below re-applies through setOption on a mode flip.
    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current)
    }
    const chrome = chartChrome(isDark)
    const labels = data.map((d) => d.label)
    const inputData = data.map((d) => d.input)
    const outputData = data.map((d) => d.output)

    instanceRef.current.setOption(
      {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          valueFormatter: (v: number) => v.toLocaleString(),
          backgroundColor: chrome.tooltipBg,
          borderColor: chrome.tooltipBorder,
          borderWidth: 1,
          textStyle: { color: chrome.tooltipText, fontSize: 12 },
        },
        legend: {
          data: [outputLabel, inputLabel],
          selectedMode: false,
          icon: 'circle',
          itemWidth: 8,
          itemHeight: 8,
          itemGap: 16,
          textStyle: { color: chrome.legend, fontSize: 12 },
          right: 0,
          top: 0,
        },
        grid: { left: 48, right: 8, top: 36, bottom: 24 },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { fontSize: 11, color: chrome.axisLabel },
          axisLine: { lineStyle: { color: chrome.axisLine } },
          axisTick: { alignWithLabel: true },
        },
        yAxis: {
          type: 'value',
          axisLabel: { fontSize: 11, color: chrome.axisLabel },
          splitLine: { lineStyle: { color: chrome.splitLine } },
        },
        series: [
          {
            name: outputLabel,
            type: 'bar',
            stack: 'tokens',
            data: outputData,
            itemStyle: { color: isDark ? OUTPUT_COLOR.dark : OUTPUT_COLOR.light, borderRadius: 0 },
            barCategoryGap: '20%',
          },
          {
            name: inputLabel,
            type: 'bar',
            stack: 'tokens',
            data: inputData,
            itemStyle: { color: isDark ? INPUT_COLOR.dark : INPUT_COLOR.light, borderRadius: [3, 3, 0, 0] },
            barCategoryGap: '20%',
          },
        ],
      },
      true,
    )

    const handleResize = () => instanceRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [data, inputLabel, outputLabel, isDark])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose()
      instanceRef.current = null
    }
  }, [])

  return (
    <div>
      <Title level={5} style={{ marginTop: 0, marginBottom: 16 }}>
        {title}
      </Title>
      <div ref={chartRef} style={{ width: '100%', height: 250 }} />
    </div>
  )
}

export default StatisticsPage
