import { oc } from 'ts-optchain'

import {
  ListEntryWithoutMedia,
  ListPlugin,
  ListPluginType,
} from '@/plugins/list/plugin'
import { MAL_ID_FROM_ANILIST_ID } from '@/graphql/documents/queries'
import { getAnilistIdsFromMalIds } from '@/graphql/queries'
import {
  AddToListMutation,
  EditListEntryMutation,
  EditListEntryOptions,
  ListEntry,
  MalIdFromAnilistIdQuery,
  MalIdFromAnilistIdQueryVariables,
  MediaListStatus,
  QueryListEntriesArgs,
  StartRewatchingMutation,
  UpdateProgressMutation,
  UpdateScoreMutation,
  UpdateStatusMutation,
} from '@/graphql/types'
import { getIsConnectedTo } from '@/state/auth'
import { Simkl, SimklListEntry } from '@/lib/simkl'
import { ArmServer } from '@/lib/arm-server'
import { isNil } from '@/utils'

export class SimklListPlugin extends ListPlugin implements ListPlugin {
  public static service = 'simkl'
  public service = 'simkl'
  public static type = ListPluginType.Full
  public type = ListPluginType.Full

  isAvailable(): boolean {
    return getIsConnectedTo(this.store).simkl
  }

  private async getMALId(anilistId: number) {
    const ids = await ArmServer.getIdsFor('anilist', anilistId)

    let malId = oc(ids).myanimelist() || null

    if (isNil(malId)) {
      const response = await this.apollo.query<MalIdFromAnilistIdQuery>({
        fetchPolicy: 'cache-first',
        query: MAL_ID_FROM_ANILIST_ID,
        variables: { mediaId: anilistId } as MalIdFromAnilistIdQueryVariables,
      })

      malId = oc(response).data.Media.idMal() || null
    }

    return malId
  }

  private fromWatchedInfo(anilistId: number, data: SimklListEntry): ListEntry {
    const entry: ListEntryWithoutMedia = {
      __typename: 'ListEntry',
      id: data.show.ids.simkl,
      mediaId: anilistId,
      progress: data.watched_episodes_count,
      rewatched: 0,
      score: data.user_rating * 10,
      status: Simkl.statusFromSimklStatus(data.status),
    }

    return entry as ListEntryWithoutMedia & { media: any }
  }

  public async GetListEntry(anilistId: number): Promise<ListEntry | null> {
    const malId = await this.getMALId(anilistId)

    if (isNil(malId)) return null

    const item = await Simkl.watchedInfo(malId)

    if (isNil(item)) {
      return null
    }

    const listEntry = this.fromWatchedInfo(anilistId, item)
    return listEntry
  }

  public async GetListEntries(
    options: QueryListEntriesArgs,
  ): Promise<ListEntry[]> {
    // defaulting the values in the parameters didn't work for some reason
    options = options || {}

    const result = await Simkl.getAllListEntries()
    const malIds = result.map(info => Number(info.show.ids.mal))
    const relations = await getAnilistIdsFromMalIds(this.apollo, malIds)

    const idInfoMap = result.map(info => {
      const relation = relations.find(
        ids => ids.idMal === Number(info.show.ids.mal),
      )

      return [oc(relation).id(), info] as const
    })

    const entries = idInfoMap
      .filter((item): item is [number, SimklListEntry] => !isNil(item[0]))
      .map(item => this.fromWatchedInfo(...item))

    if (!isNil(options.perPage) && !isNil(options.page)) {
      return entries.slice(
        options.perPage * (options.page - 1),
        options.perPage * options.page,
      )
    }

    return entries
  }

  public async AddToList(
    anilistId: number,
  ): Promise<AddToListMutation['AddToList']> {
    return this.UpdateStatus(anilistId, MediaListStatus.Planning)
  }

  public async DeleteFromList(anilistId: number): Promise<boolean> {
    const malId = await this.getMALId(anilistId)

    if (isNil(malId)) return true

    return Simkl.removeFromList(malId)
  }

  public async StartRewatching(
    anilistId: number,
  ): Promise<StartRewatchingMutation['StartRewatching']> {
    await this.UpdateStatus(anilistId, MediaListStatus.Repeating)
    return this.UpdateProgress(anilistId, 0)
  }

  public async UpdateProgress(
    anilistId: number,
    progress: number,
  ): Promise<UpdateProgressMutation['UpdateProgress']> {
    const malId = await this.getMALId(anilistId)

    if (isNil(malId)) {
      throw new Error('Could not find necessary data to add item to list.')
    }

    await Simkl.setProgress(malId, progress)

    const item = await Simkl.watchedInfo(malId)

    if (isNil(item)) {
      throw new Error('Failed to update item.')
    }

    if (item.watched_episodes_count === (item.total_episodes_count || -1)) {
      return this.UpdateStatus(anilistId, MediaListStatus.Completed)
    }

    return this.fromWatchedInfo(anilistId, item)
  }

  public async UpdateScore(
    anilistId: number,
    score: number,
  ): Promise<UpdateScoreMutation['UpdateScore']> {
    const malId = await this.getMALId(anilistId)
    const rating = Math.round(score / 10)

    if (isNil(malId)) {
      throw new Error('Could not find necessary data to add item to list.')
    }

    await Simkl.addRating(malId, rating)

    const item = await Simkl.watchedInfo(malId)

    if (isNil(item)) {
      throw new Error('Failed to update item.')
    }

    return this.fromWatchedInfo(anilistId, {
      ...item,
      user_rating: rating,
    })
  }

  public async UpdateStatus(
    anilistId: number,
    status: MediaListStatus,
  ): Promise<UpdateStatusMutation['UpdateStatus']> {
    const malId = await this.getMALId(anilistId)

    if (isNil(malId)) {
      throw new Error('Could not find necessary data to add item to list.')
    }

    await Simkl.addItemToList(malId, Simkl.simklStatusFromMediaStatus(status))

    const item = await Simkl.watchedInfo(malId)

    if (isNil(item)) {
      throw new Error('Failed to update list entry on Simkl.')
    }

    return this.fromWatchedInfo(anilistId, item)
  }

  public async EditListEntry(
    anilistId: number,
    { score, progress, status }: EditListEntryOptions,
  ): Promise<EditListEntryMutation['EditListEntry']> {
    const malId = await this.getMALId(anilistId)

    if (isNil(malId)) {
      throw new Error('Could not find necessary data to add item to list.')
    }

    const promises: Promise<any>[] = [
      Simkl.addItemToList(malId, Simkl.simklStatusFromMediaStatus(status)),
      Simkl.setProgress(malId, progress),
    ]

    if (!isNil(score)) {
      promises.push(Simkl.addRating(malId, Math.round(score / 10)))
    }

    await Promise.all(promises)

    const item = await Simkl.watchedInfo(malId)

    if (isNil(item)) {
      throw new Error('Failed to save list entry on Simkl.')
    }

    return this.fromWatchedInfo(anilistId, item)
  }
}