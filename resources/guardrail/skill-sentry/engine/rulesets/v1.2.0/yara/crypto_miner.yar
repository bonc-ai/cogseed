/*
 * crypto_miner.yar — 挖矿载荷签名
 *
 * 挖矿协议（stratum）与矿池域名是最稳的判据；矿工程序名单独出现时不构成
 * 结论（安全文档会提到 xmrig），因此程序名规则要求同时出现配置特征。
 */
rule Mining_Pool_Protocol
{
    meta:
        severity = "critical"
        category = "crypto_miner"
        confidence = "high"
        sr = "SR-03"
        description = "挖矿协议地址（stratum）"
        remediation = "删除挖矿载荷并上报安全团队"
    strings:
        $tcp = "stratum+tcp://" nocase
        $ssl = "stratum+ssl://" nocase
        $tls = "stratum+tls://" nocase
        $s2 = "stratum2+tcp://" nocase
    condition:
        any of them
}

rule Mining_Pool_Host
{
    meta:
        severity = "critical"
        category = "crypto_miner"
        confidence = "high"
        sr = "SR-03"
        description = "已知矿池域名"
        remediation = "删除挖矿配置并上报安全团队"
    strings:
        $pool1 = "minexmr.com" nocase
        $pool2 = "supportxmr.com" nocase
        $pool3 = "nanopool.org" nocase
        $pool4 = "2miners.com" nocase
        $pool5 = "ethermine.org" nocase
        $pool6 = "moneroocean.stream" nocase
        $pool7 = "hashvault.pro" nocase
        $pool8 = "nicehash.com" nocase
        $pool9 = "c3pool.com" nocase
        $pool10 = "herominers.com" nocase
    condition:
        any of ($pool*)
}

rule XMRig_Config_Shape
{
    meta:
        severity = "critical"
        category = "crypto_miner"
        confidence = "high"
        sr = "SR-03"
        description = "XMRig 配置形态（algo + donate-level + pool）"
        remediation = "删除挖矿配置并上报安全团队"
    strings:
        $algo = "\"algo\"" nocase
        $donate = "\"donate-level\"" nocase
        $pool = "\"pool\"" nocase
    condition:
        all of them
}

rule Miner_Binary_With_Config
{
    meta:
        severity = "critical"
        category = "crypto_miner"
        confidence = "high"
        sr = "SR-03"
        description = "矿工程序名与挖矿配置同时出现"
        remediation = "删除矿工二进制与配置并上报安全团队"
    strings:
        $miner1 = "xmrig" nocase
        $miner2 = "minerd" nocase
        $miner3 = "cpuminer" nocase
        $miner4 = "ccminer" nocase
        $config1 = "stratum" nocase
        $config2 = "donate-level" nocase
        $config3 = "cryptonight" nocase
    condition:
        any of ($miner*) and any of ($config*)
}

rule Browser_Crypto_Miner
{
    meta:
        severity = "high"
        category = "crypto_miner"
        confidence = "high"
        sr = "SR-03"
        description = "浏览器挖矿脚本（Coinhive 及其同形态）"
        remediation = "移除挖矿脚本"
    strings:
        $coinhive1 = "coinhive.min.js" nocase
        $coinhive2 = "CoinHive.Anonymous" nocase
        $cryptoloot = "cryptoloot" nocase
    condition:
        any of them
}
