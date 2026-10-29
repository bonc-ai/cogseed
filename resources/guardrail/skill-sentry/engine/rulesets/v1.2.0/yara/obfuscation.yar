/*
 * obfuscation.yar — 解码后执行的组合形态
 *
 * 纯正则规则能看到 base64_decode / eval 各自出现；这一组要求「解码动作」与
 * 「执行动作」在同一文件里共现，从而把「解释编码原理」的正常文档与真实载荷
 * 分开——文档里的命中仍会被上下文降权，但结构上不再与载荷同形。
 */
rule Base64_Pipe_To_Shell
{
    meta:
        severity = "critical"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "base64 解码后直接管道到 shell"
        remediation = "移除编码载荷；安装步骤应固定版本并校验哈希"
    strings:
        $decode1 = "base64 -d"
        $decode2 = "base64 --decode"
        $decode3 = "openssl enc -d"
        $pipe1 = "| sh"
        $pipe2 = "| bash"
        $pipe3 = "|sh"
        $pipe4 = "|bash"
    condition:
        any of ($decode*) and any of ($pipe*)
}

rule PowerShell_Base64_Execution
{
    meta:
        severity = "high"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "PowerShell 从 base64 还原并执行"
        remediation = "移除编码执行；脚本应以明文形式接受审计"
    strings:
        $decode = "FromBase64String" nocase
        $exec1 = "Invoke-Expression" nocase
        $exec2 = "IEX" nocase
        $exec3 = "-EncodedCommand" nocase
    condition:
        $decode and any of ($exec*)
}

rule Node_Eval_Atob
{
    meta:
        severity = "high"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "Node/浏览器端 eval(atob(...)) 编码执行"
        remediation = "移除编码执行；审计所需的逻辑应保留可读源码"
    strings:
        $eval_atob = "eval(atob("
        $eval_buffer = "eval(Buffer.from("
    condition:
        any of them
}

rule Python_Marshal_Exec
{
    meta:
        severity = "high"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "Python marshal 反序列化后执行"
        remediation = "移除 marshal 载荷；不要把序列化字节当作代码执行"
    strings:
        $load = "marshal.loads"
        $exec1 = "exec("
        $exec2 = "eval("
    condition:
        $load and any of ($exec*)
}

rule PHP_Base64_Eval
{
    meta:
        severity = "high"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "PHP base64_decode 后执行"
        remediation = "移除编码执行；保留可审计源码"
    strings:
        $decode = "base64_decode" nocase
        $exec1 = "eval(" nocase
        $exec2 = "assert(" nocase
        $exec3 = "create_function(" nocase
    condition:
        $decode and any of ($exec*)
}

rule Gzip_Pipe_To_Shell
{
    meta:
        severity = "high"
        category = "obfuscation"
        confidence = "high"
        sr = "SR-03"
        description = "压缩流解压后直接执行"
        remediation = "移除压缩执行链；下载内容应先落盘并校验"
    strings:
        $decode1 = "gunzip"
        $decode2 = "gzip -d"
        $decode3 = "xz -d"
        $decode4 = "tar -xz"
        $pipe1 = "| sh"
        $pipe2 = "| bash"
        $pipe3 = "|sh"
        $pipe4 = "|bash"
    condition:
        any of ($decode*) and any of ($pipe*)
}
