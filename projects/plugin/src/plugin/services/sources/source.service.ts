import { Injectable } from '@angular/core';
import { catchError, last, map, mapTo, switchMap, takeUntil, tap } from 'rxjs/operators';
import { CachedTorrentSourceService } from './cached-torrent-source.service';
import { TorrentSourceService } from './torrent-source.service';
import { SourceQuery } from '../../entities/source-query';
import { HeliosCacheService } from '../provider-cache.service';
import { concat, EMPTY, forkJoin, from, merge, Observable, of, Subject } from 'rxjs';
import { SettingsService } from '../settings.service';
import { Provider } from '../../entities/provider';
import { SourceByProvider } from '../../entities/source-by-provider';
import { ProviderService } from '../provider.service';
import { LastPlayedSource } from '../../entities/last-played-source';
import { StreamLinkSource } from '../../entities/stream-link-source';
import { TorrentsFilterOnWantedQualityQuery } from '../../queries/torrents/torrents-filter-on-wanted-quality.query';
import { Settings } from '../../entities/settings';
import { TorrentSource } from '../../entities/torrent-source';
import { StreamLinkSourceDetail } from '../../entities/stream-link-source-detail';
import { KodiOpenMedia } from '../../entities/kodi-open-media';
import { TmdbSeasonGetByIdForm } from '../tmdb/forms/seasons/tmdb-season-get-by-id.form';
import { SourceQueryFromKodiOpenMediaQuery } from '../../queries/source-query-from-kodi-open-media.query';
import { incrementEpisodeCode } from '../tools';

const GET_LAST_MOVIE_PLAYED_SOURCE_CACHE_KEY = 'helios_previousplayed_movie2';
const GET_LAST_SHOW_PLAYED_SOURCE_CACHE_KEY = 'helios_previousplayed_show2';

@Injectable()
export class SourceService {
  constructor(
    private cachedTorrentSourceService: CachedTorrentSourceService,
    private torrentSourceService: TorrentSourceService,
    private settingsService: SettingsService,
    private providerService: ProviderService
  ) {}

  private getByProvider(sourceQuery: SourceQuery, provider: Provider) {
    return this.torrentSourceService.getByProvider(sourceQuery, provider).pipe(
      switchMap((torrentSourceDetail) => {
        return from(this.settingsService.get()).pipe(
          switchMap((settings) => {
            if (sourceQuery.movie || sourceQuery.episode) {
              torrentSourceDetail.sources = TorrentsFilterOnWantedQualityQuery.getData(torrentSourceDetail.sources, settings.qualities);
            }

            const startTime = Date.now();
            return this.cachedTorrentSourceService.getFromTorrents(torrentSourceDetail.sources, sourceQuery).pipe(
              map((streamLinks) => {
                const endTime = Date.now();

                const streamLinkSourceDetail = new StreamLinkSourceDetail();

                streamLinkSourceDetail.provider = provider.name;
                streamLinkSourceDetail.sources = streamLinks;
                streamLinkSourceDetail.timeElapsed = endTime - startTime;

                return {
                  provider: provider.name,
                  torrentSourceDetail: torrentSourceDetail,
                  cachedTorrentDetail: streamLinkSourceDetail,
                  timeElapsedTotal: torrentSourceDetail.timeElapsed + streamLinkSourceDetail.timeElapsed
                } as SourceByProvider;
              })
            );
          })
        );
      })
    );
  }

  getLastMoviePlayedSource() {
    return HeliosCacheService.get<LastPlayedSource>(GET_LAST_MOVIE_PLAYED_SOURCE_CACHE_KEY);
  }

  async setLastMoviePlayedSource(id: string, title: string, provider: string) {
    return await HeliosCacheService.set(
      GET_LAST_MOVIE_PLAYED_SOURCE_CACHE_KEY,
      {
        id,
        title,
        provider
      } as LastPlayedSource,
      '1m'
    );
  }

  getLastEpisodePlayedSource(showTraktId: number) {
    return HeliosCacheService.get<LastPlayedSource>(GET_LAST_SHOW_PLAYED_SOURCE_CACHE_KEY + '_' + showTraktId).pipe(
      switchMap((data) => {
        if (!data) {
          return HeliosCacheService.get<LastPlayedSource>(GET_LAST_SHOW_PLAYED_SOURCE_CACHE_KEY);
        }
        return of(data);
      })
    );
  }

  async setLastEpisodePlayedSource(id: string, title: string, provider: string, showTraktId: number) {
    await HeliosCacheService.set(
      GET_LAST_SHOW_PLAYED_SOURCE_CACHE_KEY + '_' + showTraktId,
      {
        id,
        title,
        provider,
        showTraktId
      } as LastPlayedSource,
      '1m'
    );

    return await HeliosCacheService.set(
      GET_LAST_SHOW_PLAYED_SOURCE_CACHE_KEY,
      {
        id,
        title,
        provider,
        showTraktId
      } as LastPlayedSource,
      '1m'
    );
  }

  private getBestSourceFromSourceByProviders(
    sourceQuery: SourceQuery,
    sourceByProviders: SourceByProvider[],
    settings: Settings,
    lastPlayedSource: LastPlayedSource
  ) {
    if (settings.defaultPlayButtonAction === 'open-elementum') {
      const torrentSources: TorrentSource[] = [];

      sourceByProviders.forEach((sourceByProvider) => {
        torrentSources.push(...sourceByProvider.torrentSourceDetail.sources);
      });

      const source = this.torrentSourceService.getBestSource(torrentSources, lastPlayedSource);

      return of(source);
    }
    const streamLinkSources: StreamLinkSource[] = [];

    sourceByProviders.forEach((sourceByProvider) => {
      streamLinkSources.push(...sourceByProvider.cachedTorrentDetail.sources);
    });

    return this.cachedTorrentSourceService.getBestSource(streamLinkSources, sourceQuery, lastPlayedSource);
  }

  private getBestSourcesObservables(
    sourceQuery: SourceQuery,
    providers: Provider[],
    settings: Settings,
    lastPlayedSource: LastPlayedSource,
    totalProviderInSequence = 4
  ) {
    // Let's proceed X providers by X providers
    let obss: Observable<SourceByProvider>[] = [];
    const groupObss: Observable<TorrentSource | StreamLinkSource>[] = [];

    providers.forEach((provider) => {
      if (lastPlayedSource && provider.name === lastPlayedSource.provider) {
        groupObss.unshift(
          this.getByProvider(sourceQuery, provider).pipe(
            switchMap((sourceByProvider) => {
              return this.getBestSourceFromSourceByProviders(sourceQuery, [sourceByProvider], settings, lastPlayedSource);
            })
          )
        );
        return;
      }
      obss.push(this.getByProvider(sourceQuery, provider));
      if (typeof totalProviderInSequence === 'number' && obss.length % totalProviderInSequence === 0) {
        groupObss.push(
          forkJoin(...obss).pipe(
            switchMap((sourceByProviders) => {
              return this.getBestSourceFromSourceByProviders(sourceQuery, sourceByProviders, settings, lastPlayedSource);
            })
          )
        );
        obss = [];
      }
    });

    if (obss.length > 0) {
      groupObss.push(
        forkJoin(...obss).pipe(
          switchMap((sourceByProviders) => {
            return this.getBestSourceFromSourceByProviders(sourceQuery, sourceByProviders, settings, lastPlayedSource);
          })
        )
      );
    }

    return groupObss;
  }

  private setEpisodeAbsoluteNumberIfAnime(sourceQuery: SourceQuery) {
    if (!sourceQuery.episode || !sourceQuery.episode.isAnime || sourceQuery.episode.absoluteNumber > 0) {
      return of(null);
    }
    return TmdbSeasonGetByIdForm.submit(sourceQuery.episode.showTmdbId, sourceQuery.episode.season).pipe(
      catchError(() => {
        return EMPTY;
      }),
      map((tmdbSeason) => {
        tmdbSeason.episodes.forEach((episode) => {
          if (episode.episode_number === sourceQuery.episode.season) {
            sourceQuery.episode.absoluteNumber = episode.production_code;
          }
        });
      })
    );
  }

  private getBestSource(sourceQuery: SourceQuery, stopIfFirstSourceIsNull = false, type?: 'torrent' | 'stream') {
    return from(this.settingsService.get()).pipe(
      switchMap((settings) => {
        if (!type) {
          type = settings.defaultPlayButtonAction === 'open-elementum' ? 'torrent' : 'stream';
        }
        return this.getBestSourceFromProviders(sourceQuery, stopIfFirstSourceIsNull);
      })
    );
  }

  private getBestSourceFromProviders(sourceQuery: SourceQuery, stopIfFirstSourceIsNull = false) {
    let getLatestPlayedSource: Observable<LastPlayedSource> = null;
    if (sourceQuery.movie) {
      getLatestPlayedSource = this.getLastMoviePlayedSource();
    } else {
      getLatestPlayedSource = this.getLastEpisodePlayedSource(sourceQuery.episode.showTraktId);
    }

    let settings: Settings;
    let providers: Provider[];
    let done = 0;
    let totalToDo = 0;
    return new Observable<TorrentSource | StreamLinkSource>((observer) => {
      const bestSourceReturned$ = new Subject();

      from(this.settingsService.get())
        .pipe(
          switchMap((d) => {
            settings = d;
            return from(this.providerService.getAll(true, sourceQuery.category));
          }),
          switchMap((d) => {
            providers = d;
            return getLatestPlayedSource;
          }),
          switchMap((lastPlayedSource) => {
            const groupObss = this.getBestSourcesObservables(sourceQuery, providers, settings, lastPlayedSource, 4);

            totalToDo = groupObss.length;

            return concat(...groupObss).pipe(
              takeUntil(bestSourceReturned$),
              tap(() => {
                done++;
              })
            );
          })
        )
        .subscribe(
          (bestSource) => {
            if (bestSource || stopIfFirstSourceIsNull) {
              bestSourceReturned$.next(true);

              observer.next(bestSource);
              observer.complete();

              if (bestSource) {
                if (sourceQuery.movie) {
                  this.setLastMoviePlayedSource(bestSource.id, bestSource.title, bestSource.provider);
                } else {
                  this.setLastEpisodePlayedSource(bestSource.id, bestSource.title, bestSource.provider, sourceQuery.episode.showTraktId);
                }
              }
            }

            if (done === totalToDo && !bestSource) {
              observer.next(bestSource);
              observer.complete();
            }
          },
          (err) => observer.error(err)
        );
    });
  }

  getBestSourceFromKodiOpenMedia(kodiOpenMedia: KodiOpenMedia) {
    return SourceQueryFromKodiOpenMediaQuery.getData(kodiOpenMedia).pipe(
      switchMap((sourceQuery) => {
        return this.getBestSource(sourceQuery);
      })
    );
  }

  getAll(sourceQuery: SourceQuery) {
    if (sourceQuery.query && sourceQuery.query.trim().length === 0) {
      return EMPTY;
    }

    let providers: Provider[];

    return this.setEpisodeAbsoluteNumberIfAnime(sourceQuery).pipe(
      switchMap(() => {
        return from(this.providerService.getAll(true, sourceQuery.category));
      }),
      switchMap((d) => {
        providers = d;
        const obss: Observable<SourceByProvider>[] = [];
        providers.forEach((provider) => {
          obss.push(this.getByProvider(sourceQuery, provider));
        });

        return from(this.settingsService.get()).pipe(
          switchMap((settings) => {
            if (settings.simultaneousProviderQueries === 0) {
              return merge(...obss);
            }

            const gourpObss: Observable<SourceByProvider>[] = [];
            let _obss: Observable<SourceByProvider>[] = [];
            obss.forEach((obs, index) => {
              _obss.push(obs);

              if (index % settings.simultaneousProviderQueries === 0) {
                gourpObss.push(merge(..._obss));
                _obss = [];
              }
            });

            if (_obss.length > 0) {
              gourpObss.push(merge(..._obss));
            }

            return concat(...gourpObss);
          })
        );
      })
    );
  }

  getNextEpisodeSources(sourceQuery: SourceQuery, type?: 'torrent' | 'stream') {
    let limit = sourceQuery.episode.latestAiredEpisode - sourceQuery.episode.episode;

    if (limit > 3) {
      limit = 3;
    }

    const obss: Observable<{ source: TorrentSource | StreamLinkSource; sourceQuery: SourceQuery }>[] = [];
    let episodeCode = sourceQuery.episode.episodeCode;
    let episodeAbsoluteNumber = sourceQuery.episode.absoluteNumber;
    let episode = sourceQuery.episode.episode;

    for (let i = 0; i < limit; i++) {
      const _sourceQuery = JSON.parse(JSON.stringify(sourceQuery));
      episodeCode = incrementEpisodeCode(episodeCode);

      if (episodeAbsoluteNumber) {
        episodeAbsoluteNumber++;
        _sourceQuery.episode.absoluteNumber = episodeAbsoluteNumber;
      }
      episode++;
      _sourceQuery.episode.episode = episode;

      _sourceQuery.episode.episodeCode = episodeCode;

      obss.push(
        this.getBestSource(_sourceQuery, true, type).pipe(
          map((source) => {
            return {
              source,
              sourceQuery: _sourceQuery
            };
          })
        )
      );
    }

    const stop$ = new Subject();

    let added = false;

    const nextSources: (TorrentSource | StreamLinkSource)[] = [];

    return concat(...obss).pipe(
      takeUntil(stop$),
      switchMap((data: { source: TorrentSource | StreamLinkSource; sourceQuery: SourceQuery }) => {
        const source = data.source;

        if (source === null) {
          return of(null);
        }

        if (source.type === 'torrent') {
          added = true;

          nextSources.push(data.source);

          return of(true);
        } else if (source instanceof StreamLinkSource) {
          if (!source.streamLinks || (source.streamLinks.length > 1 && added)) {
            stop$.next(true);
            return of(null);
          }

          added = true;

          nextSources.push(data.source);
        }

        return of(true);
      }),
      last(),
      mapTo(nextSources)
    );
  }
}
