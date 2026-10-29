/*
 * destructive_ransomware.yar — 破坏性操作与勒索软件形态
 *
 * 这一组规则要么是极具辨识度的命令行（如 dd 写零到整个磁盘），要么是勒索
 * 提示文案。它们不与其他类别共享关键词，因此单独出现即可判定。
 */
rule Shadow_Copy_Deletion
{
    meta:
        severity = "critical"
        category = "destructive"
        confidence = "high"
        sr = "SR-03"
        description = "删除卷影副本/备份目录（勒索软件前置动作）"
        remediation = "移除该命令；备份与恢复点只能由管理员在隔离环境操作"
    strings:
        $shadow = "vssadmin delete shadows" nocase
        $catalog = "wbadmin delete catalog" nocase
        $recovery = "bcdedit /set recoveryenabled no" nocase
    condition:
        any of them
}

rule Ransom_Note_Markers
{
    meta:
        severity = "critical"
        category = "destructive"
        confidence = "high"
        sr = "SR-03"
        description = "勒索提示文案"
        remediation = "删除该载荷并上报安全团队"
    strings:
        $note1 = "YOUR FILES ARE ENCRYPTED" nocase
        $note2 = "All your files have been encrypted" nocase
        $note3 = "README_DECRYPT" nocase
        $note4 = "DECRYPT_INSTRUCTIONS" nocase
        $note5 = "your files have been locked" nocase
    condition:
        any of them
}

rule Disk_Wipe_Command
{
    meta:
        severity = "critical"
        category = "destructive"
        confidence = "high"
        sr = "SR-03"
        description = "磁盘擦除/格式化命令"
        remediation = "移除该命令；任何整盘操作都必须由用户显式确认目标设备"
    strings:
        $dd_zero = "dd if=/dev/zero of=/dev/"
        $dd_random = "dd if=/dev/urandom of=/dev/"
        $mkfs = "mkfs.ext4 /dev/"
        $mkfs2 = "mkfs.xfs /dev/"
        $wipefs = "wipefs -a"
        $no_preserve = "--no-preserve-root"
    condition:
        any of them
}

rule File_Shred_Loop
{
    meta:
        severity = "medium"
        category = "destructive"
        confidence = "medium"
        sr = "SR-03"
        description = "递归删除并覆写文件（破坏性清理）"
        remediation = "删除前必须让用户确认范围；不要在脚本里自动执行不可逆清理"
    strings:
        $shred = "shred "
        $find = "find "
        $delete = "-delete"
    condition:
        $shred and $find and $delete
}
