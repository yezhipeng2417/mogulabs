import { Octokit } from '@octokit/rest'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { validateMarketplace } from './validate.js'
import type { CollectedMarketplace, MarketplaceData, RawMarketplace } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, '..', 'public', 'data', 'marketplaces.json')

const SEARCH_DELAY_MS = 6000 // 6s between search API calls
const REPO_DELAY_MS = 200   // 200ms between repo API calls

const octokit = new Octokit({
  auth: process.env['GITHUB_TOKEN'],
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function searchMarketplaceRepos(): Promise<string[]> {
  const repos: string[] = []
  let page = 1
  const perPage = 100

  console.log('Searching for repos with .claude-plugin/marketplace.json...')

  while (true) {
    const { data } = await octokit.search.code({
      q: 'filename:marketplace.json path:.claude-plugin',
      per_page: perPage,
      page,
    })

    for (const item of data.items) {
      const fullName = item.repository.full_name
      if (!repos.includes(fullName)) {
        repos.push(fullName)
      }
    }

    console.log(`  Page ${page}: found ${data.items.length} results (total unique repos: ${repos.length})`)

    if (data.items.length < perPage) break
    page++
    await sleep(SEARCH_DELAY_MS)
  }

  console.log(`Found ${repos.length} unique repos.`)
  return repos
}

async function collectMarketplace(fullName: string): Promise<CollectedMarketplace | null> {
  const [owner, repo] = fullName.split('/')

  try {
    // Get repo info
    const { data: repoData } = await octokit.repos.get({ owner: owner!, repo: repo! })

    // Get marketplace.json content
    const { data: fileData } = await octokit.repos.getContent({
      owner: owner!,
      repo: repo!,
      path: '.claude-plugin/marketplace.json',
    })

    if (!('content' in fileData)) {
      console.warn(`  ${fullName}: not a file`)
      return null
    }

    const content = Buffer.from(fileData.content, 'base64').toString('utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      console.warn(`  ${fullName}: invalid JSON`)
      return null
    }

    const marketplace: RawMarketplace | null = validateMarketplace(parsed)
    if (!marketplace) {
      console.warn(`  ${fullName}: failed validation`)
      return null
    }

    const plugins = marketplace.plugins.map((p) => ({
      name: p.name,
      description: p.description,
      version: p.version,
      source: p.source,
      author: p.author,
      category: p.category,
      tags: p.tags,
      strict: p.strict,
      homepage: p.homepage,
      repository: p.repository,
      license: p.license,
      hasCommands: !!p.commands && Object.keys(p.commands).length > 0,
      hasAgents: !!p.agents && Object.keys(p.agents).length > 0,
      hasHooks: !!p.hooks && Object.keys(p.hooks).length > 0,
      hasSkills: !!p.skills && Object.keys(p.skills).length > 0,
      hasMcp: !!p.mcpServers && Object.keys(p.mcpServers).length > 0,
      hasLsp: !!p.lspServers && Object.keys(p.lspServers).length > 0,
    }))

    return {
      repo: fullName,
      repoUrl: repoData.html_url,
      stars: repoData.stargazers_count,
      forks: repoData.forks_count,
      topics: repoData.topics ?? [],
      license: repoData.license?.spdx_id ?? null,
      repoDescription: repoData.description,
      repoUpdatedAt: repoData.updated_at ?? new Date().toISOString(),
      repoCreatedAt: repoData.created_at ?? new Date().toISOString(),
      ownerAvatar: repoData.owner.avatar_url,
      name: marketplace.name,
      version: marketplace.version,
      description: marketplace.description,
      owner: marketplace.owner,
      pluginCount: plugins.length,
      plugins,
      categories: marketplace.categories,
    }
  } catch (err) {
    console.warn(`  ${fullName}: error - ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function main() {
  console.log('=== Claude Code Marketplace Collector ===\n')

  const repos = await searchMarketplaceRepos()

  console.log('\nCollecting marketplace data...')
  const marketplaces: CollectedMarketplace[] = []

  for (const fullName of repos) {
    console.log(`  Processing ${fullName}...`)
    const result = await collectMarketplace(fullName)
    if (result) {
      marketplaces.push(result)
      console.log(`    OK: ${result.name} (${result.pluginCount} plugins)`)
    }
    await sleep(REPO_DELAY_MS)
  }

  // Sort by stars descending
  marketplaces.sort((a, b) => b.stars - a.stars)

  const totalPlugins = marketplaces.reduce((sum, m) => sum + m.pluginCount, 0)

  const output: MarketplaceData = {
    updatedAt: new Date().toISOString(),
    totalMarketplaces: marketplaces.length,
    totalPlugins,
    marketplaces,
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2))
  console.log(`\nDone! Wrote ${marketplaces.length} marketplaces (${totalPlugins} plugins) to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
