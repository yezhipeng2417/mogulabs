import { Octokit } from '@octokit/rest'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { validateMarketplace } from './validate.js'
import type { CollectedMarketplace, MarketplaceData, RawMarketplace } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(__dirname, '..', 'public', 'data', 'marketplaces.json')

const SEARCH_DELAY_MS = 6000 // 6s between search API calls
const REPO_DELAY_MS = 200   // 200ms between repo API calls
const MAX_RETRIES = 5
const INITIAL_RETRY_MS = 10_000 // 10s initial backoff for rate limits

const octokit = new Octokit({
  auth: process.env['GITHUB_TOKEN'],
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      const retryAfter = (err as { response?: { headers?: Record<string, string> } }).response?.headers?.['retry-after']

      if (status === 429 || status === 403) {
        if (attempt === MAX_RETRIES) throw err
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_RETRY_MS * Math.pow(2, attempt)
        console.warn(`  ${label}: rate limited (${status}), retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`)
        await sleep(waitMs)
      } else {
        throw err
      }
    }
  }
  throw new Error('unreachable')
}

function loadExisting(): Map<string, CollectedMarketplace> {
  const map = new Map<string, CollectedMarketplace>()
  if (!existsSync(OUTPUT_PATH)) return map

  try {
    const raw = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) as MarketplaceData
    for (const m of raw.marketplaces) {
      map.set(m.repo, m)
    }
    console.log(`Loaded ${map.size} existing marketplaces from cache.`)
  } catch {
    console.warn('Failed to load existing data, starting fresh.')
  }
  return map
}

async function searchMarketplaceRepos(): Promise<string[]> {
  const repoSet = new Set<string>()
  let page = 1
  const perPage = 100

  console.log('Searching for repos with .claude-plugin/marketplace.json...')

  while (true) {
    const { data } = await withRetry(
      () => octokit.search.code({
        q: 'filename:marketplace.json path:.claude-plugin',
        per_page: perPage,
        page,
      }),
      `search page ${page}`,
    )

    for (const item of data.items) {
      repoSet.add(item.repository.full_name)
    }

    console.log(`  Page ${page}: found ${data.items.length} results (total unique repos: ${repoSet.size})`)

    if (data.items.length < perPage) break
    page++
    await sleep(SEARCH_DELAY_MS)
  }

  console.log(`Found ${repoSet.size} unique repos.`)
  return [...repoSet]
}

async function updateStarsAndForks(
  existing: CollectedMarketplace,
): Promise<CollectedMarketplace | null> {
  const [owner, repo] = existing.repo.split('/')
  try {
    const { data: repoData } = await withRetry(
      () => octokit.repos.get({ owner: owner!, repo: repo! }),
      existing.repo,
    )
    return {
      ...existing,
      stars: repoData.stargazers_count,
      forks: repoData.forks_count,
      topics: repoData.topics ?? [],
      license: repoData.license?.spdx_id ?? null,
      repoDescription: repoData.description,
      repoUpdatedAt: repoData.updated_at ?? existing.repoUpdatedAt,
      ownerAvatar: repoData.owner.avatar_url,
    }
  } catch (err) {
    console.warn(`  ${existing.repo}: failed to update stats - ${err instanceof Error ? err.message : String(err)}`)
    return existing // keep stale data rather than dropping it
  }
}

async function collectMarketplace(fullName: string): Promise<CollectedMarketplace | null> {
  const [owner, repo] = fullName.split('/')

  try {
    const { data: repoData } = await withRetry(
      () => octokit.repos.get({ owner: owner!, repo: repo! }),
      fullName,
    )

    const { data: fileData } = await withRetry(
      () => octokit.repos.getContent({
        owner: owner!,
        repo: repo!,
        path: '.claude-plugin/marketplace.json',
      }),
      `${fullName}/marketplace.json`,
    )

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

  const existing = loadExisting()
  const repos = await searchMarketplaceRepos()
  const searchedRepos = new Set(repos)

  // Split into new repos vs existing repos
  const newRepos = repos.filter((r) => !existing.has(r))
  const existingRepos = repos.filter((r) => existing.has(r))
  // Repos in cache but no longer found in search — drop them
  const removedCount = [...existing.keys()].filter((r) => !searchedRepos.has(r)).length

  console.log(`\n  New repos: ${newRepos.length}`)
  console.log(`  Existing repos (update stats): ${existingRepos.length}`)
  console.log(`  Removed repos (no longer found): ${removedCount}`)

  const marketplaces: CollectedMarketplace[] = []

  // Full collect for new repos
  if (newRepos.length > 0) {
    console.log('\nCollecting new marketplaces...')
    for (const fullName of newRepos) {
      console.log(`  Processing ${fullName}...`)
      const result = await collectMarketplace(fullName)
      if (result) {
        marketplaces.push(result)
        console.log(`    OK: ${result.name} (${result.pluginCount} plugins)`)
      }
      await sleep(REPO_DELAY_MS)
    }
  }

  // Lightweight update for existing repos (stars, forks, topics, etc.)
  if (existingRepos.length > 0) {
    console.log('\nUpdating stats for existing marketplaces...')
    for (const fullName of existingRepos) {
      const cached = existing.get(fullName)!
      const updated = await updateStarsAndForks(cached)
      if (updated) {
        marketplaces.push(updated)
      }
      await sleep(REPO_DELAY_MS)
    }
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
