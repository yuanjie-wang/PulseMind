import React from 'react'

interface TerminalOutputProps {
  output: string
  isError?: boolean
}

const containerStyle: React.CSSProperties = {
  background: '#1e1e1e',
  borderRadius: 6,
  padding: '8px 12px',
  fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
  fontSize: 12,
  lineHeight: 1.5,
  color: '#d4d4d4',
  maxHeight: 200,
  overflowY: 'auto',
  marginTop: 4,
  marginBottom: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all'
}

function TerminalOutput({ output, isError }: TerminalOutputProps): React.ReactElement {
  return (
    <div
      style={{
        ...containerStyle,
        borderLeft: isError ? '3px solid #f44747' : '3px solid #4ec9b0'
      }}
    >
      {output}
    </div>
  )
}

export default TerminalOutput
