export class SourceMovieQuery {
  imdbId: string;
  tmdbId: number;
  year: number;
  title: string;
  defaultTitleLang: string;
  alternativeTitles?: { [key: string]: string };
  originalTitle?: string;
}

export class SourceEpisodeQuery extends SourceMovieQuery {
  episode: number;
  season: number;
  episodeCode: string;
  seasonCode: string;
  episodeTitle: string;
  absoluteNumber?: number;
  latestAiredEpisode?: number;
  isAnime: boolean;
  tvdbId: string;
  trakId: number;
  simklId: number;
  showTvdbId: string;
  showTraktId: number;
  showTmdbId: number;
  showSimklId: number;
  showImdbId: string;
}

export interface SourceQuery {
  query?: string; // Manual search
  movie?: SourceMovieQuery;
  episode?: SourceEpisodeQuery;
  category: 'movie' | 'tv' | 'anime';
}
