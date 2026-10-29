/*
 * credential_stealer.yar — 凭据收集与外传
 *
 * 这里只收「读取凭据 + 存在外传通道」的组合。单独读取 `.ssh/id_rsa` 在运维
 * 脚本里可能是合法用途，单独的 curl 更是；组合起来才是外传形态。
 */
rule SSH_Key_Exfiltration
{
    meta:
        severity = "critical"
        category = "credential_access"
        confidence = "high"
        sr = "SR-01"
        description = "读取 SSH 私钥并将其外发"
        remediation = "不要读取用户私钥；确需凭据时由用户显式提供，并改为本地使用"
    strings:
        $key1 = ".ssh/id_rsa"
        $key2 = ".ssh/id_ed25519"
        $key3 = ".ssh/id_ecdsa"
        $sink1 = "curl "
        $sink2 = "wget "
        $sink3 = "requests.post"
        $sink4 = "urllib.request"
        $sink5 = "nc "
    condition:
        any of ($key*) and any of ($sink*)
}

rule Cloud_Credential_Exfiltration
{
    meta:
        severity = "critical"
        category = "credential_access"
        confidence = "high"
        sr = "SR-01"
        description = "读取云厂商凭据文件并外发"
        remediation = "凭据只能由运行时注入并在本机使用，不得离开机器"
    strings:
        $cred1 = ".aws/credentials"
        $cred2 = ".config/gcloud"
        $cred3 = ".azure/accessTokens"
        $cred4 = ".kube/config"
        $sink1 = "curl "
        $sink2 = "wget "
        $sink3 = "requests.post"
        $sink4 = "urllib.request"
        $sink5 = "nc "
    condition:
        any of ($cred*) and any of ($sink*)
}

rule Keychain_Dump_Command
{
    meta:
        severity = "critical"
        category = "credential_access"
        confidence = "high"
        sr = "SR-01"
        description = "导出 macOS 钥匙串"
        remediation = "移除钥匙串导出；凭据应由系统授权按需读取"
    strings:
        $dump = "security dump-keychain"
        $find = "security find-generic-password"
        $write = "-w"
    condition:
        $dump or ($find and $write)
}

rule Browser_Credential_Store_Theft
{
    meta:
        severity = "critical"
        category = "credential_access"
        confidence = "high"
        sr = "SR-01"
        description = "读取浏览器保存的密码库"
        remediation = "移除对浏览器凭据库的读取"
    strings:
        $store1 = "Login Data"
        $store2 = "logins.json"
        $store3 = "signons.sqlite"
        $store4 = "key4.db"
        $access1 = "sqlite3"
        $access2 = "password_value"
        $access3 = "SELECT"
    condition:
        any of ($store*) and any of ($access*)
}

rule Discord_Webhook_Token_Exfiltration
{
    meta:
        severity = "high"
        category = "credential_access"
        confidence = "high"
        sr = "SR-01"
        description = "读取浏览器 localStorage/LevelDB 并通过 Discord Webhook 外发"
        remediation = "移除令牌收集与外发通道"
    strings:
        $hook1 = "discord.com/api/webhooks/" nocase
        $hook2 = "discordapp.com/api/webhooks/" nocase
        $source1 = "localStorage" nocase
        $source2 = "leveldb" nocase
        $source3 = "tokens" nocase
    condition:
        any of ($hook*) and any of ($source*)
}

rule Environment_Dump_To_Remote
{
    meta:
        severity = "high"
        category = "data_egress"
        confidence = "medium"
        sr = "SR-04"
        description = "把整份环境变量导出并发送到远端"
        remediation = "不要把环境变量整体外发；只发送显式声明的非敏感字段"
    strings:
        // 只认「整份导出」。`os.environ.get(...)` 与 `requests.post(...)` 同时出现
        // 是再正常不过的客户端代码（实测在自家两个内置 Skill 上误报），
        // 判据必须落在「把环境整体序列化」这个动作上。
        $dump1 = "printenv"
        $dump2 = "dict(os.environ)"
        $dump3 = "json.dumps(os.environ"
        $dump4 = "JSON.stringify(process.env)"
        $dump5 = "Object.entries(process.env)"
        $sink1 = "curl "
        $sink2 = "wget "
        $sink3 = "requests.post"
        $sink4 = "fetch("
    condition:
        any of ($dump*) and any of ($sink*)
}

rule Crypto_Wallet_Archive_Theft
{
    meta:
        severity = "high"
        category = "credential_access"
        confidence = "medium"
        sr = "SR-01"
        description = "打包加密钱包文件（钱包窃取形态）"
        remediation = "移除对钱包文件的收集与打包"
    strings:
        $wallet1 = "wallet.dat"
        $wallet2 = "MetaMask"
        $wallet3 = "Exodus/wallet"
        $pack1 = "zipfile"
        $pack2 = "shutil.make_archive"
        $pack3 = "zip -"
    condition:
        any of ($wallet*) and any of ($pack*)
}
