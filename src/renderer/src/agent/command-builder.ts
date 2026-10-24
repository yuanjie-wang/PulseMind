import { shEscape, shSingleQuote, psEscape } from './agent-utils'

/** search/find 的 search_dir 缺省与相对解析（audit 2026-10-10 #5）：执行器
 *  的 shell 以 $HOME 兜底 cwd，search_dir 省略时曾等于全 home 扫描。缺省回
 *  会话 workspace；相对路径挂 workspace（与主进程 file-ops resolvePath 同一
 *  坐标系）；绝对路径与 ~ 原样（~ 由下方各命令构造器的 $HOME 前缀展开）。
 *  只在真正执行 search/find 的执行器调用——审批/白名单侧的命令重建永远见不
 *  到 read 档工具，不需要同一默认值。 */
export function withDefaultSearchDir(
  input: Record<string, unknown>,
  workspaceDir?: string,
): Record<string, unknown> {
  const raw = String(input.search_dir || '').trim()
  if (!raw || raw === '.') {
    return workspaceDir ? { ...input, search_dir: workspaceDir } : input
  }
  if (/^[/\\]|[A-Za-z]:[/\\]/.test(raw) || raw.startsWith('~')) return input
  const sep = workspaceDir?.includes('\\') ? '\\' : '/'
  return workspaceDir ? { ...input, search_dir: workspaceDir + sep + raw } : input
}

export function buildCommandFromSkillInput(toolName: string, input: Record<string, unknown>, platform: string, ripgrepPath?: string | null): string {
  const isWin = platform === 'win32' || (
    !platform && typeof navigator !== 'undefined' && /Windows|Win64/i.test(navigator.userAgent)
  )
  switch (toolName) {
    case 'read': {
      const filePath = String(input.file_path || '')
      // Floor at 1 (2026-10-24 harness review): a negative offset/limit passed
      // straight through — `head -n -5` is "all but the last 5 lines" on GNU
      // and a hard error on BSD/macOS, `tail -n +-3` likewise. Cap stays 500.
      const offset = Math.max(1, Number(input.offset) || 1)
      // Hard cap: a page is bounded at 500 lines — the structural bound;
      // token-level overflow is read's dedicated budget's job
      // (MAX_READ_RESULT_TOKENS in engine-constants).
      const limit = Math.max(1, Math.min(Number(input.limit) || 500, 500))
      // ~ 路径在引号里不展开（audit 2026-10-10 #6）。Windows 的单引号内一切
      // 字面，$env:USERPROFILE 拼进 '…' 曾永远读不到（full_20261011 M2-P1-3）
      // ——变量必须在引号外：Join-Path 展开变量、路径本体仍单引号免注入。
      const hasTilde = filePath.startsWith('~')
      if (isWin) {
        const psPath = hasTilde
          ? `(Join-Path $env:USERPROFILE '${psEscape(filePath.slice(1))}')`
          : `'${psEscape(filePath)}'`
        if (input.binary === true) {
          return `Format-Hex -Path ${psPath} | Select-Object -Skip ($(${offset}) - 1) -First ${limit} | Out-String -Width 4096`
        }
        return `Get-Content -Path ${psPath} -Encoding utf8 | Select-Object -Skip ($(${offset}) - 1) -First ${limit}`
      }
      const escapedPath = hasTilde ? '$HOME' + shEscape(filePath.slice(1)) : shEscape(filePath)
      // xxd ships with vim (present on macOS, often ABSENT on slim
      // Linux/AppImage targets) — fall back to POSIX-baseline od for the hex
      // dump instead of failing the whole read arm there.
      if (input.binary === true) return `(command -v xxd >/dev/null 2>&1 && xxd "${escapedPath}" || od -A x -t x1z "${escapedPath}") | tail -n +${offset} | head -n ${limit}`
      return `tail -n +${offset} "${escapedPath}" | head -n ${limit}`
    }
    case 'write':
      return '(IPC write — not executed via shell)'
    case 'edit':
      return 'echo "Edit tool is handled via IPC; this path should not execute."'
    case 'list_dir': {
      const dirPath = String(input.dir_path || '')
      if (!dirPath) return 'Error: dir_path is required'
      const hasTilde = dirPath.startsWith('~')
      const offset = Math.max(0, Number(input.offset) || 0)
      // Default limit bounds every listing at 100 entries even when `limit` is
      // omitted, keeping a page well under the 4K-token tool-result guardrail.
      // Floored at 1: a zero/negative page size is caller noise, not "all rows".
      const limit = Math.max(1, input.limit !== undefined && input.limit !== null ? Number(input.limit) : 100)
      if (isWin) {
        // 同 read：$env:USERPROFILE 曾被拼进单引号字面量，list_dir ~/… 在
        // Windows 必败（先存同款，随 M2-P1-3 一并修）。
        const wrapped = hasTilde
          ? `(Join-Path $env:USERPROFILE '${psEscape(dirPath.slice(1))}')`
          : `'${psEscape(dirPath)}'`
        if (input.recursive === true) {
          let cmd = `Get-ChildItem -Path ${wrapped} -Recurse -Depth 2 -Force | Where-Object { $_.Name -notlike '.*' } | Select-Object -ExpandProperty FullName`
          cmd += ` | Select-Object -Skip ${offset} -First ${limit}`
          return cmd + ` | Out-String`
        }
        let cmd = `Get-ChildItem -Path ${wrapped} -Force`
        cmd += ` | Select-Object -Skip ${offset} -First ${limit}`
        return cmd + ` | Select-Object Mode, Length, LastWriteTime, Name | Out-String`
      }
      const escapedPath = hasTilde ? '$HOME' + shEscape(dirPath.slice(1)) : shEscape(dirPath)
      if (input.recursive === true) {
        return `find "${escapedPath}" -maxdepth 2 -not -name '.*' 2>/dev/null | tail -n +${offset + 1} | head -n ${limit}`
      }
      return `ls -la "${escapedPath}" | tail -n +${offset + 2} | head -n ${limit}`
    }
    case 'search': {
      const query = String(input.query || '')
      const searchDir = String(input.search_dir || '.')
      const include = String(input.include || '')
      const exclude = String(input.exclude || '')
      const includePatterns = include ? include.split(',').map(s => s.trim()).filter(Boolean) : []
      const excludePatterns = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : []
      const mkIncludeFlags = (ps: string[]) => ps.map(p => ` -g '${psEscape(p)}'`).join('')
      const mkExcludeFlags = (ps: string[]) => ps.map(p => ` -g '!${psEscape(p)}'`).join('')
      // The grep fallback rides the same `sh -c` channel as every arm above —
      // a double-quoted glob let `$( )` substitute (review_20261006 高1, the
      // P1-02 fix took the rg arms and missed these two). `--include=GLOB` is
      // a single argv word either way, so POSIX quoting is equivalent.
      const mkGrepInclude = (ps: string[]) => ps.map(p => ` --include=${shSingleQuote(p)}`).join('')
      const mkGrepExclude = (ps: string[]) => ps.map(p => ` --exclude=${shSingleQuote(p)}`).join('')
      if (isWin) {
        if (ripgrepPath) {
          let cmd = `& '${psEscape(ripgrepPath)}' -n --no-heading -i --max-columns 200 '${psEscape(query)}' '${psEscape(searchDir)}'`
          cmd += mkIncludeFlags(includePatterns) + mkExcludeFlags(excludePatterns)
          return cmd + ' | Select-Object -First 100'
        }
        let cmd = `if (Get-Command rg -ErrorAction SilentlyContinue) { `
        cmd += `rg -n --no-heading -i --max-columns 200 '${psEscape(query)}' '${psEscape(searchDir)}'`
        cmd += mkIncludeFlags(includePatterns) + mkExcludeFlags(excludePatterns)
        cmd += ` 2>$null } else { `
        cmd += `Get-ChildItem -Path '${psEscape(searchDir)}' -Recurse -File`
        if (include) cmd += ` -Include '${psEscape(include)}'`
        if (exclude) {
          cmd += ` | Where-Object { ${excludePatterns.map(p => `$_.FullName -notlike '${psEscape('*' + p.replace(/^\*+/, ''))}'`).join(' -and ')} }`
        }
        cmd += ` | Select-String -Pattern '${psEscape(query)}' | Select-Object -First 100 | ForEach-Object { $_.Filename + ':' + $_.LineNumber + ':' + $_.Line.Trim() }`
        cmd += ` }`
        return cmd
      }

      if (ripgrepPath) {
        let cmd = `"${shEscape(ripgrepPath)}" -n --no-heading -i --max-columns 200 ${shSingleQuote(query)} ${shSingleQuote(searchDir)}`
        cmd += includePatterns.map(p => ` -g ${shSingleQuote(p)}`).join('')
        cmd += excludePatterns.map(p => ` -g ${shSingleQuote('!' + p)}`).join('')
        // stderr 并进输出（audit 2026-10-10 #4）：管道以 head 收尾，rg 的退出
        // 码到不了执行器——/dev/null 曾把正则错误这类真实失败一起吞成空输出。
        return cmd + ' 2>&1 | head -100'
      }
      let cmd = `if command -v rg >/dev/null 2>&1; then rg -n --no-heading -i --max-columns 200 ${shSingleQuote(query)} ${shSingleQuote(searchDir)}`
      cmd += includePatterns.map(p => ` -g ${shSingleQuote(p)}`).join('')
      cmd += excludePatterns.map(p => ` -g ${shSingleQuote('!' + p)}`).join('')
      cmd += ` 2>&1; else grep -rn "${shEscape(query)}" "${shEscape(searchDir)}"`
      cmd += mkGrepInclude(includePatterns) + mkGrepExclude(excludePatterns)
      cmd += ` 2>&1; fi | head -100`
      return cmd
    }
    case 'find': {
      const pattern = String(input.pattern || '')
      const searchDir = String(input.search_dir || '.')
      const maxDepth = Number(input.max_depth) || 5
      const type = String(input.type || '')
      const extraArgs = String(input.extra_args || '')
      if (isWin) {
        const typeParam = type === 'f' ? ' -File' : type === 'd' ? ' -Directory' : ''
        return `Get-ChildItem -Path '${psEscape(searchDir)}' -Recurse -Depth ${Math.min(maxDepth, 10)}${typeParam} -Force${pattern ? ` -Filter '${psEscape(pattern)}'` : ''} -ErrorAction SilentlyContinue | Where-Object { !$_.PSPath.Contains('\\.git\\') -and !$_.PSPath.Contains('\\node_modules\\') } | Select-Object -ExpandProperty FullName | Select-Object -First 100 | Out-String`
      }
      // type 白名单（audit 2026-10-10 #2）：find 是 read 档（永不审批），
      // 任意拼写曾原样插进 shell 串。
      const typeExpr = type === 'f' || type === 'd' ? `-type ${type}` : ''
      // extra_args 同一注入面（schema 把它宣传为逃生舱，但审批梯子按工具名
      // 放行——带元字符的 extra_args 就是无审批的任意命令）。普通 find 谓词
      // （-o -name "x"、-mtime -7）不含这些字符，误伤为零。
      if (/[;|&`$()<>\n\r]/.test(extraArgs)) {
        return 'echo "Error: extra_args contains shell metacharacters — pass plain find arguments only (e.g. -o -name \\"*.env*\\")"'
      }
      // 元字符黑名单挡不住 find 自己的执行谓词（review_20261011 高1）：`-exec
      // sh {} +` 的 `+` 终结符不含任何元字符，read 档照样免审批跑命令。按
      // token 拒整个写副作用家族；前缀匹配盖住 -execdir/-fprintf 这类变体。
      // shell 在分词之后、交给 find 之前还会做词中引号/反斜杠剥离（review_
      // 20261015 高1：`-ex"e"c` / `-e'x'ec` / `-ex\ec` / `\-exec` 到 find 眼里
      // 都重建出 `-exec`，实测绕过只剥前导引号的旧防线）——判前缀前先把转义
      // 逐字还原、引号字符全剥。find 谓词名是纯字母与连字符，凡 shell 能重建
      // 出谓词的拼写这里剥完必然同形（剥不掉的只会多删字符，前缀照旧命中）；
      // 剥错的残余误伤只落在「文件名带引号/反斜杠且恰好拼出谓词前缀」的病态
      // 输入上，方向是拒绝（fail-closed）。
      const FORBIDDEN_FIND_PREFIXES = ['-exec', '-ok', '-fprint', '-fls', '-delete']
      const hasForbiddenPredicate = extraArgs
        .split(/\s+/)
        .some((tok) => {
          const bare = tok.replace(/\\(.)/g, '$1').replace(/['"]/g, '')
          return FORBIDDEN_FIND_PREFIXES.some((p) => bare.startsWith(p))
        })
      if (hasForbiddenPredicate) {
        return 'echo "Error: extra_args contains forbidden find predicates (-exec/-execdir/-ok/-fprint/-fls/-delete execute or write — not allowed in a read-tier search)"'
      }
      const nameExpr = pattern ? `-iname ${shSingleQuote(pattern)}` : ''
      const cond = [typeExpr, nameExpr, extraArgs].filter(Boolean).join(' ')
      return `find ${shSingleQuote(searchDir)} -maxdepth ${Math.min(maxDepth, 10)} ${cond} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -100`
    }
    case 'ask_user': {
      const prompt = String(input.prompt || 'Ask the user')
      const choices = String(input.choices || '')
      const choiceList = choices ? choices.split(',').map((c) => c.trim()).filter(Boolean) : []

      if (isWin) {
        if (choiceList.length > 0) {
          const items = choiceList.map(c => `'${psEscape(c)}'`).join(', ')
          return `${items} | Out-GridView -Title '${psEscape(prompt)}' -OutputMode Single | Out-String`
        }
        return `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('${psEscape(prompt)}', 'PulseMind')`
      }

      if (platform === 'linux') {
        if (choiceList.length > 0) {
          const items = choiceList.map(c => shSingleQuote(c)).join(' ')
          return `zenity --list --title=${shSingleQuote(prompt)} --column='' ${items} --print-column=1 2>/dev/null || kdialog --menu ${shSingleQuote(prompt)} ${items} 2>/dev/null || echo "CANCELLED"`
        }
        return `zenity --entry --title=${shSingleQuote(prompt)} --text=${shSingleQuote(prompt)} 2>/dev/null || kdialog --inputbox ${shSingleQuote(prompt)} '' 2>/dev/null || echo "CANCELLED"`
      }

      // macOS (default)
      if (choiceList.length > 0) {
        // AppleScript string escaping (backslash FIRST, then quote) — the same
        // layer the single-select arm below uses. The old shape shEscape'd the
        // prompt (a SHELL layer: `\$` is a syntax error inside AppleScript
        // "…", so any $-bearing prompt failed the whole dialog) and left items
        // with raw backslashes un-escaped (a Windows path string failed too).
        const asEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const multiFlag = input.multi === true ? ' with multiple selections allowed' : ''
        const items = choiceList.map(c => `"${asEscape(c)}"`).join(', ')
        return `osascript << 'OSAEOF'\nset theChoices to {${items}}\nset theSelection to choose from list theChoices with prompt "${asEscape(prompt)}"${multiFlag}\nif theSelection is false then\n  return "CANCELLED"\nelse\n  set AppleScript's text item delimiters to ", "\n  return theSelection as text\nend if\nOSAEOF`
      }
      // The -e payload rides a SINGLE-quoted shell arg, so a raw ' in the prompt
      // closed it — same injection class as the '…' contexts above (found while
      // fixing review_20261005 P1-02). Escape for the AppleScript "…" string
      // first, then hand the whole payload to shSingleQuote.
      const dialogScript = `display dialog "${prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" default answer ""`
      return `osascript -e ${shSingleQuote(dialogScript)} -e 'text returned of result'`
    }
    case 'exec': {
      const command = String(input.command || '')
      const cwd = String(input.cwd || '')
      if (input.sudo === true) {
        if (isWin) {
          const escapedCmd = command.replace(/'/g, "''")
          return `Start-Process -Verb RunAs -Wait -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','${escapedCmd}'`
        }
        if (platform === 'darwin') {
          // cwd rides POSIX '…' (review_20261007 高1: the old "\\'" was NOT an
          // escape inside single quotes — one raw ' in cwd closed the wrap and
          // the rest executed with administrator privileges). shSingleQuote's
          // '\'' dance survives the AppleScript layer below: its \' is doubled
          // to \\' by the escape pass and do shell script un-doubles it before
          // handing the string to /bin/sh.
          const fullCmd = cwd ? `cd ${shSingleQuote(cwd)} && ${command}` : command
          const escaped = fullCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          return `osascript << 'OSAEOF'\ndo shell script "${escaped}" with administrator privileges\nOSAEOF`
        }
        return `sudo ${command}`
      }
      return command
    }
    default: {
      if (typeof input.command === 'string' && input.command.trim()) return input.command.trim()
      const entries = Object.entries(input).map(([k, v]) => `${k}=${String(v)}`).join(' ')
      return `echo "Unrecognized tool: ${toolName} (${entries})"`
    }
  }
}
