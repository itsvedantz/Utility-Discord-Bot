import type { AnyInteraction, Command, IntentionalAny } from 'src/types';

import throttle from 'lodash.throttle';
import YouTubeSr from 'youtube-sr';
import { SlashCommandBuilder } from '@discordjs/builders';
import { CommandInteraction, MessageEmbed, MessageEmbedOptions, ModalSubmitInteraction } from 'discord.js';
import { Colors } from 'src/constants';
import { error } from 'src/logging';
import { isTwitchVodLink, shuffleArray } from 'src/utils';
import { parseInput } from 'src/discord-utils';
import sessions from './sessions';
import Track, { TrackVariant } from './track';
import Session from './session';
import {
  LinkType,
  parseSpotifyAlbum,
  parseSpotifyLink,
  parseSpotifyPlaylist,
  parseSpotifyTrack,
} from './spotify';
import { parseYoutubePlaylist, getTracksFromQueries } from './youtube';
import { attachPlayerButtons, getFractionalDuration } from './utils';

function respondWithEmbed(interaction: AnyInteraction, content: MessageEmbedOptions) {
  return interaction.editReply({
    embeds: [new MessageEmbed({
      color: Colors.SUCCESS,
      ...content,
    })],
  });
}

async function enqueue(session: Session, tracks: Track[], pushToFront: boolean): Promise<MessageEmbedOptions> {
  const wasPlayingAnything = Boolean(session.getCurrentTrack());
  await session.enqueue(tracks, pushToFront);

  try {
    const videoDetails = await tracks[0].getVideoDetails();
    if (wasPlayingAnything && tracks.length > 1) {
      return { description: `Queued ${tracks.length} tracks.` };
    }
    if (tracks.length > 1) {
      return { description: `Now playing: ${videoDetails.title}\nQueued ${tracks.length - 1} tracks.` };
    }
    if (wasPlayingAnything) {
      return { description: `Queued at position #${pushToFront ? 1 : session.queue.length}: ${videoDetails.title}` };
    }
    const footerText = getFractionalDuration(0, videoDetails);
    return {
      author: {
        name: '🔊 Now Playing',
      },
      description: videoDetails.title,
      footer: {
        text: footerText || undefined,
      },
    };
  } catch (err) {
    error(tracks[0].link, tracks[0].variant, err);
    return {
      description: 'Could not fetch video details.'
        + ' This video probably cannot be played for some reason.'
        + ' This can happen if the video is age-restricted or region-locked.',
    };
  }
}

async function enqueueQueries(session: Session, queries: string[], interaction: AnyInteraction): Promise<IntentionalAny> {
  if (session.isShuffled()) shuffleArray(queries);
  const [firstQuery, ...restQueries] = queries;
  const [firstTrack] = await getTracksFromQueries([firstQuery]);
  const firstTrackPartialMessage = await enqueue(session, [firstTrack], false);

  function concatDescription(oldOptions: MessageEmbedOptions, newDescription: string): MessageEmbedOptions {
    return {
      ...oldOptions,
      description: oldOptions.description ? `${oldOptions.description}\n${newDescription}` : newDescription,
    };
  }

  await respondWithEmbed(interaction, concatDescription(firstTrackPartialMessage, `Fetching the other ${restQueries.length} tracks from YouTube...`));

  let numFetched = 0;
  const throttledMessageUpdate = throttle(async () => {
    if (numFetched === 0) {
      return respondWithEmbed(
        interaction,
        concatDescription(firstTrackPartialMessage, `Fetching the other ${restQueries.length} tracks from YouTube...`),
      );
    }
    if (numFetched < restQueries.length) {
      return respondWithEmbed(interaction, concatDescription(firstTrackPartialMessage, `Queued ${
        numFetched
      } tracks.\nFetching the other ${
        restQueries.length - numFetched
      } tracks from YouTube...`));
    }
    return respondWithEmbed(interaction, concatDescription(firstTrackPartialMessage, `Queued ${numFetched} tracks from YouTube.`));
  }, 5000);

  getTracksFromQueries(restQueries, async newTracks => {
    await session.enqueue(newTracks);
    numFetched += newTracks.length;
    await throttledMessageUpdate();
  });
}

interface PlayInputs {
  vodLink: string | null,
  streamLink: string | null,
  queryStr: string | null,
  pushToFront?: boolean,
  shuffle?: boolean,
}

async function play({
  interaction,
  inputs: {
    vodLink,
    streamLink,
    queryStr,
    pushToFront = false,
    shuffle = false,
  },
}: {
  interaction: CommandInteraction | ModalSubmitInteraction,
  inputs: PlayInputs,
}) {
  const numArgs = [vodLink, streamLink, queryStr].filter(Boolean).length;

  // Assert guild since this is a guild-only command
  const guild = interaction.guild!;

  const { user } = interaction;
  if (!user) {
    return interaction.editReply('Could not resolve user invoking command.');
  }
  const resolvedMember = await guild.members.fetch(user.id);
  const { channel } = resolvedMember.voice;
  if (!channel) {
    return interaction.editReply('You must be connected to a voice channel.');
  }
  if (!channel.joinable) {
    return interaction.editReply('I don\'t have permission to connect to your voice channel.');
  }

  let session = sessions.get(guild);
  if (session) session.resume();

  if (numArgs === 0 && !session) {
    return interaction.editReply('You must provide at least one argument.');
  }

  if (!session) session = sessions.create(channel);

  if (shuffle) session.shuffle();

  if (vodLink) {
    if (isTwitchVodLink(vodLink)) {
      const track = new Track(vodLink, TrackVariant.TWITCH_VOD);
      const responseMessage = await enqueue(session, [track], pushToFront);
      await respondWithEmbed(interaction, responseMessage);
      return attachPlayerButtons(interaction, session);
    }

    if (YouTubeSr.validate(vodLink, 'VIDEO') || YouTubeSr.validate(vodLink, 'PLAYLIST')) {
      const tracks = YouTubeSr.isPlaylist(vodLink)
        ? (await parseYoutubePlaylist(vodLink))
        : [new Track(vodLink, TrackVariant.YOUTUBE_VOD)];
      const responseMessage = await enqueue(session, tracks, pushToFront);
      await respondWithEmbed(interaction, responseMessage);
      return attachPlayerButtons(interaction, session);
    }

    try {
      const { type } = parseSpotifyLink(vodLink);
      switch (type) {
        case LinkType.PLAYLIST: {
          const queries = await parseSpotifyPlaylist(vodLink);
          if (queries.length > 1) {
            await enqueueQueries(session, queries, interaction);
            return attachPlayerButtons(interaction, session);
          }
          const tracks = await getTracksFromQueries(queries);
          const responseMessage = await enqueue(session, tracks, pushToFront);
          await respondWithEmbed(interaction, responseMessage);
          return attachPlayerButtons(interaction, session);
        }
        case LinkType.ALBUM: {
          const queries = await parseSpotifyAlbum(vodLink);
          if (queries.length > 1) {
            return enqueueQueries(session, queries, interaction);
          }
          const tracks = await getTracksFromQueries(queries);
          const responseMessage = await enqueue(session, tracks, pushToFront);
          await respondWithEmbed(interaction, responseMessage);
          return attachPlayerButtons(interaction, session);
        }
        case LinkType.TRACK: {
          const query = await parseSpotifyTrack(vodLink);
          const tracks = await getTracksFromQueries([query]);
          const responseMessage = await enqueue(session, tracks, pushToFront);
          await respondWithEmbed(interaction, responseMessage);
          return attachPlayerButtons(interaction, session);
        }
        default: {
          throw new Error('Could not parse Spotify link.');
        }
      }
    } catch {
      // Intentionally empty
    }

    throw new Error('Invalid link.');
  }
  if (streamLink) {
    if (!YouTubeSr.validate(streamLink, 'VIDEO')) {
      return interaction.editReply('Invalid YouTube link.');
    }
    const tracks = [new Track(streamLink, TrackVariant.YOUTUBE_LIVESTREAM)];
    const responseMessage = await enqueue(session, tracks, pushToFront);
    await respondWithEmbed(interaction, responseMessage);
    return attachPlayerButtons(interaction, session);
  }
  if (queryStr) {
    const tracks = await getTracksFromQueries([queryStr]);
    const responseMessage = await enqueue(session, tracks, pushToFront);
    await respondWithEmbed(interaction, responseMessage);
    return attachPlayerButtons(interaction, session);
  }
  await interaction.editReply('Resumed.');
  return attachPlayerButtons(interaction, session);
}

const commandBuilder = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Plays audio into a voice channel.')
  .addStringOption(option => option.setName('link').setDescription('YouTube, Spotify, Twitch. No livestreams.').setRequired(false))
  .addStringOption(option => option.setName('query').setDescription('Generic query for YouTube.').setRequired(false))
  .addStringOption(option => option.setName('stream').setDescription('YouTube livestream. Twitch is not currently supported.').setRequired(false))
  .addBooleanOption(option => option.setName('front').setDescription('Push song (one) to the front of the queue.').setRequired(false))
  .addBooleanOption(option => option.setName('shuffle').setDescription('Shuffle the queue.').setRequired(false));

const PlayCommand: Command = {
  guildOnly: true,
  showModalWithNoArgs: true,
  slashCommandData: commandBuilder,

  modalLabels: {
    stream: 'YouTube livestream. (Not Twitch).',
  },
  modalPlaceholders: {
    link: 'https://...',
    query: 'A song',
    stream: 'https://...',
    front: 'yes/no',
    shuffle: 'yes/no',
  },

  runModal: async interaction => {
    await interaction.deferReply({ ephemeral: true });
    const inputs = await parseInput({
      slashCommandData: commandBuilder,
      interaction,
    });
    await play({
      interaction,
      inputs: {
        vodLink: inputs.link,
        streamLink: inputs.stream,
        queryStr: inputs.query,
        pushToFront: inputs.front,
        shuffle: inputs.shuffle,
      },
    });
  },

  runCommand: async interaction => {
    await interaction.deferReply({ ephemeral: true });
    const vodLink = interaction.options.getString('link');
    const streamLink = interaction.options.getString('stream');
    const queryStr = interaction.options.getString('query');
    const pushToFront = interaction.options.getBoolean('front') ?? false;
    const shuffle = interaction.options.getBoolean('shuffle') ?? false;

    await play({
      interaction,
      inputs: {
        vodLink,
        streamLink,
        queryStr,
        pushToFront,
        shuffle,
      },
    });
  },
};

export default PlayCommand;
