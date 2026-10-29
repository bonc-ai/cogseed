/*
 * persistence.yar — 持久化签名
 *
 * 判据是「持久化位置 + 自启动配置」的结构组合；单独写 crontab 在部署脚本里
 * 完全正常，因此除个别明确的提权/后门写法外都要求组合。
 */
rule Cron_Reboot_Beacon
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "high"
        sr = "SR-03"
        description = "写入 @reboot 计划任务并拉取远端内容"
        remediation = "移除自启动拉取；确有需要时固定来源并校验签名"
    strings:
        $cron = "crontab"
        $reboot = "@reboot"
        $dl1 = "curl"
        $dl2 = "wget"
        $shell = "bash -i"
    condition:
        all of ($cron, $reboot) and any of ($dl*, $shell)
}

rule LaunchAgent_Persistence
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "high"
        sr = "SR-03"
        description = "安装 LaunchAgent 自启动项"
        remediation = "移除自启动安装；如为产品所需，必须由用户显式确认"
    strings:
        $dir = "LaunchAgents"
        $args = "ProgramArguments"
        $run = "RunAtLoad"
    condition:
        all of them
}

rule Systemd_Service_Remote_Exec
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "high"
        sr = "SR-03"
        description = "安装 systemd 服务并执行远端下载内容"
        remediation = "移除服务安装；如为产品所需，固定可执行文件并校验哈希"
    strings:
        $dir = "systemd/system"
        $exec = "ExecStart="
        $shell1 = "/bin/sh"
        $shell2 = "/bin/bash"
        $dl1 = "curl"
        $dl2 = "wget"
    condition:
        all of ($dir, $exec) and any of ($shell*, $dl*)
}

rule Windows_Run_Key_Write
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "high"
        sr = "SR-03"
        description = "写入 Windows 开机启动项"
        remediation = "移除 Run 键写入；自启动必须由安装器在用户知情下完成"
    strings:
        $key = "CurrentVersion\\Run"
        $reg = "reg add" nocase
    condition:
        all of them
}

rule Authorized_Keys_Injection
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "medium"
        sr = "SR-03"
        description = "向 authorized_keys 追加公钥（SSH 后门形态）"
        remediation = "移除公钥注入；确需配置访问权限时由用户明确提供公钥"
    strings:
        $file = "authorized_keys"
        $append = ">>"
        $key1 = "ssh-rsa"
        $key2 = "ssh-ed25519"
    condition:
        all of ($file, $append) and any of ($key1, $key2)
}

rule Sudoers_Nopasswd_Write
{
    meta:
        severity = "high"
        category = "privilege"
        confidence = "medium"
        sr = "SR-03"
        description = "写入 NOPASSWD sudoers 规则"
        remediation = "移除免密提权配置"
    strings:
        $nopass = "NOPASSWD"
        $file = "sudoers"
        $append = ">>"
    condition:
        all of them
}

rule Audit_Defense_Disabled
{
    meta:
        severity = "high"
        category = "persistence"
        confidence = "medium"
        sr = "SR-03"
        description = "关闭审计/强制访问控制（掩盖痕迹）"
        remediation = "移除对审计与安全模块的关闭操作"
    strings:
        $audit1 = "auditctl -e 0"
        $audit2 = "systemctl stop auditd"
        $selinux = "setenforce 0"
    condition:
        any of them
}

rule History_Cover_Up
{
    meta:
        severity = "medium"
        category = "persistence"
        confidence = "medium"
        sr = "SR-03"
        description = "组合清除 shell 历史（掩盖痕迹）"
        remediation = "移除历史清理；正常脚本没有理由清除用户命令历史"
    strings:
        $clear = "history -c"
        $unset = "unset HISTFILE"
        $overwrite = "> ~/.bash_history"
        $shred = "shred -u"
    condition:
        2 of them
}
