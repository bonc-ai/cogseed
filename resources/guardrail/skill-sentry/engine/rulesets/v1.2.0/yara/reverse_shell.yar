/*
 * reverse_shell.yar — 反向 shell 形态签名
 *
 * 反向 shell 的结构是「建立连接 + 把 shell 接上去」。只看 nc / socket / bash
 * 任何一个都会在正常脚本里命中，因此除个别极具辨识度的写法外都要求组合。
 */
rule Bash_Dev_Tcp_Reverse_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "bash /dev/tcp 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $dev_tcp = "/dev/tcp/"
        $redir1 = "0>&1"
        $redir2 = "1>&0"
        $bash_i = "bash -i"
    condition:
        $dev_tcp and any of ($redir*, $bash_i)
}

rule Netcat_Exec_Reverse_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "netcat/ncat 反向 shell（-e 或 --exec）"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $nc = "nc "
        $ncat = "ncat"
        $exec1 = "-e "
        $exec2 = "--exec"
        $shell1 = "/bin/sh"
        $shell2 = "cmd.exe"
    condition:
        any of ($nc, $ncat) and any of ($exec*) and any of ($shell*)
}

rule Socat_Exec_Reverse_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "socat exec: 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $socat = "socat"
        $exec = "exec:"
        $tcp1 = "tcp:"
        $tcp2 = "tcp-listen"
    condition:
        all of ($socat, $exec) and any of ($tcp*)
}

rule Python_Socket_Dup2_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "Python socket + dup2 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $socket = "socket.socket"
        $dup2 = "dup2"
        $shell1 = "/bin/sh"
        $shell2 = "cmd.exe"
    condition:
        all of ($socket, $dup2) and any of ($shell*)
}

rule Perl_Socket_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "Perl Socket 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $module = "use Socket"
        $exec1 = "exec(\"/bin/sh\")"
        $exec2 = "exec('/bin/sh')"
    condition:
        $module and any of ($exec*)
}

rule PowerShell_TcpClient_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "PowerShell TCPClient + Invoke-Expression 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $tcp = "Net.Sockets.TCPClient" nocase
        $iex1 = "Invoke-Expression" nocase
        $iex2 = "IEX" nocase
    condition:
        $tcp and any of ($iex*)
}

rule Mkfifo_Telnet_Reverse_Shell
{
    meta:
        severity = "critical"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "mkfifo + telnet 反向 shell"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $fifo = "mkfifo"
        $telnet = "telnet"
        $shell = "/bin/sh"
    condition:
        all of them
}

rule PHP_Fsockopen_Shell
{
    meta:
        severity = "high"
        category = "reverse_shell"
        confidence = "high"
        sr = "SR-03"
        description = "PHP 套接字 + 命令执行函数（反向 shell 形态）"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $socket1 = "fsockopen"
        $socket2 = "stream_socket_client"
        $exec1 = "shell_exec"
        $exec2 = "proc_open"
        $exec3 = "popen"
    condition:
        any of ($socket*) and any of ($exec*)
}
