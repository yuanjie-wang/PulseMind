import React, { useEffect, useRef, useState } from 'react'
import { Drawer, Typography, Spin, Empty, theme } from 'antd'
import { BarChartOutlined } from '@ant-design/icons'
import * as echarts from 'echarts'
import { useTranslation } from '../../i18n/useTranslation'
import type { TokenStats } from '../../types/conversation'

const { Text, Title } = Typography

const OUTPUT_COLOR = '#1d1d1f'
const INPUT_COLOR = '#d4d4d4'

interface StatisticsDrawerProps {
  open: boolean
  onClose: () => void
}

function StatisticsDrawer({ open, onClose }: StatisticsDrawerProps): React.ReactElement {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<TokenStats | null>(null)
  const isDark = token.colorBgElevated === '#1c1c1e'

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.electronAPI.getTokenStats().then((data) => {
      setStats(data)
      setLoading(false)
    })
  }, [open])

  const hasData =
    stats &&
    (() => {
      for (const h of stats.hourly) if (h.inputTokens > 0 || h.outputTokens > 0) return true
      for (const d of stats.daily) if (d.inputTokens > 0 || d.outputTokens > 0) return true
      for (const m of stats.monthly) if (m.inputTokens > 0 || m.outputTokens > 0) return true
      return false
    })()

  return (
    <Drawer
      title={
        <span>
          <BarChartOutlined style={{ marginRight: 8 }} />
          {t('statisticsDrawer.title')}
        </span>
      }
      open={open}
      onClose={onClose}
      size={680}
    >
      {loading ? (
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <Spin size="large" />
        </div>
      ) : !hasData ? (
        <Empty
          description={<Text type="secondary">{t('statisticsDrawer.noData')}</Text>}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 40, paddingBottom: 24 }}>
          <ChartSection
            title={t('statisticsDrawer.hourlyTitle')}
            data={stats!.hourly.map((d) => ({
              label: d.time.slice(11, 16),
              input: d.inputTokens,
              output: d.outputTokens
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
              output: d.outputTokens
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
              output: d.outputTokens
            }))}
            inputLabel={t('statisticsDrawer.inputLabel')}
            outputLabel={t('statisticsDrawer.outputLabel')}
            isDark={isDark}
          />
        </div>
      )}
    </Drawer>
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
  const instanceRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!chartRef.current) return
    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current, isDark ? 'dark' : undefined)
    }
    const labels = data.map((d) => d.label)
    const inputData = data.map((d) => d.input)
    const outputData = data.map((d) => d.output)

    instanceRef.current.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: number) => v.toLocaleString(),
        backgroundColor: isDark ? '#2c2c2e' : '#fff',
        borderColor: isDark ? '#3a3a3c' : '#e8e8e8',
        borderWidth: 1,
        textStyle: { color: isDark ? '#f5f5f5' : '#1d1d1f', fontSize: 12 },
      },
      legend: {
        data: [outputLabel, inputLabel],
        selectedMode: false,
        textStyle: { color: isDark ? '#aeaeb2' : '#6e6e73', fontSize: 12 },
        top: 4,
      },
      grid: { left: 48, right: 16, top: 40, bottom: 24 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 11, color: isDark ? '#8e8e93' : '#6e6e73' },
        axisLine: { lineStyle: { color: isDark ? '#3a3a3c' : '#e8e8e8' } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: isDark ? '#8e8e93' : '#6e6e73' },
        splitLine: { lineStyle: { color: isDark ? '#3a3a3c' : '#f0f0f0' } },
      },
      series: [
        {
          name: outputLabel,
          type: 'bar',
          stack: 'tokens',
          data: outputData,
          itemStyle: { color: OUTPUT_COLOR, borderRadius: [0, 0, 0, 0] },
          barCategoryGap: '20%',
        },
        {
          name: inputLabel,
          type: 'bar',
          stack: 'tokens',
          data: inputData,
          itemStyle: { color: INPUT_COLOR, borderRadius: [2, 2, 0, 0] },
          barCategoryGap: '20%',
        },
      ],
    }, true)

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

export default StatisticsDrawer
