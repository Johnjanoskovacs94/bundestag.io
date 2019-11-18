import { Scraper } from '@democracy-deutschland/scapacra';
import { ConferenceWeekDetailScraper } from '@democracy-deutschland/scapacra-bt';

import PROCEDURE_DEFINITIONS from '../definitions/procedure';
import CONFERENCEWEEKDETAIL_DEFINITIONS from '../definitions/conferenceWeekDetail';

import ConferenceWeekDetailModel from '../models/ConferenceWeekDetail';
import ProcedureModel from '../models/Procedure';

const isVote = (topic, heading) => {
  /*
  Erste Beratung = NEIN
  ——
  // Beratung des Antrags = JA , es sei denn TOP ‚Überweisungen im vereinfachten Verfahren‘ = NEIN
  Beratung des Antrags = NEIN
  ——
  Beratung der Beschlussempfehlung = JA
  Zweite und dritte Beratung = JA
  */
  if (topic.search(CONFERENCEWEEKDETAIL_DEFINITIONS.TOPIC.FIND_BERATUNG_ANTRAG) !== -1) {
    if (
      heading &&
      heading.search(CONFERENCEWEEKDETAIL_DEFINITIONS.HEADING.FIND_ABSCHLIESSENDE_BERATUNG) !== -1
    ) {
      return true;
    }
    return false;
  }
  if (topic.search(CONFERENCEWEEKDETAIL_DEFINITIONS.TOPIC.FIND_ERSTE_BERATUNG) !== -1) {
    return false;
  }
  if (
    topic.search(CONFERENCEWEEKDETAIL_DEFINITIONS.TOPIC.FIND_BERATUNG_BESCHLUSSEMPFEHLUNG) !== -1 ||
    topic.search(CONFERENCEWEEKDETAIL_DEFINITIONS.TOPIC.FIND_ZWEITE_DRITTE_BERATUNG) !== -1 ||
    topic.search(CONFERENCEWEEKDETAIL_DEFINITIONS.TOPIC.FIND_ZWEITE_BERATUNG_SCHLUSSABSTIMMUNG) !==
      -1
  ) {
    return true;
  }
  return null;
};

const getProcedureIds = async documents => {
  // TODO unify
  // currently the dip21 scraper returns document urls like so:
  // "http://dipbt.bundestag.de:80/dip21/btd/19/010/1901038.pdf
  // The named poll scraper returns them like so:
  // http://dip21.bundestag.de/dip21/btd/19/010/1901038.pdf
  const docs = documents.map(document =>
    document.replace('http://dip21.bundestag.de/', 'http://dipbt.bundestag.de:80/'),
  );
  const procedures = await ProcedureModel.find(
    {
      // Find Procedures matching any of the given Documents, excluding Beschlussempfehlung
      importantDocuments: {
        $elemMatch: {
          $and: [
            { url: { $in: docs } },
            {
              type: {
                $ne: PROCEDURE_DEFINITIONS.IMPORTANT_DOCUMENTS.TYPE.BESCHLUSSEMPFEHLUNG_BERICHT,
              },
            },
          ],
        },
      },
    },
    { procedureId: 1 },
  );

  return procedures.map(p => p.procedureId);
};

export default async () => {
  Log.info('START CONFERENCE WEEK DETAIL SCRAPER');
  try {
    const voteDates = [];
    await Scraper.scrape(new ConferenceWeekDetailScraper(), async dataPackage => {
      // Construct Database object
      const ConferenceWeekDetail = {
        URL: dataPackage.meta.url,
        id: dataPackage.data.id,
        previousYear: dataPackage.data.previous.year,
        previousWeek: dataPackage.data.previous.week,
        thisYear: dataPackage.data.this.year,
        thisWeek: dataPackage.data.this.week,
        nextYear: dataPackage.data.next.year,
        nextWeek: dataPackage.data.next.week,
        sessions: await Promise.all(
          dataPackage.data.sessions.map(async session => ({
            ...session,
            tops: await Promise.all(
              session.tops.map(async top => ({
                ...top,
                topic: await Promise.all(
                  top.topic.map(async topic => {
                    topic.isVote = isVote(topic.lines.join(' '), top.heading); // eslint-disable-line no-param-reassign
                    topic.procedureIds = await getProcedureIds(topic.documents); // eslint-disable-line no-param-reassign
                    // Save VoteDates to update them at the end when the correct values are present
                    topic.procedureIds.forEach(procedureId => {
                      voteDates[procedureId] = {
                        procedureId,
                        voteDate: topic.isVote ? top.time : null,
                      };
                    });
                    return topic;
                  }),
                ),
              })),
            ),
          })),
        ),
      };
      // Update/Insert
      await ConferenceWeekDetailModel.update(
        { id: ConferenceWeekDetail.id },
        { $set: ConferenceWeekDetail },
        { upsert: true },
      );
    });
    // Update Procedure VoteDates
    voteDates.map(async procedureUpdate => {
      await ProcedureModel.update(
        {
          procedureId: procedureUpdate.procedureId,
          // Update only when needed
          voteDate: { $ne: procedureUpdate.voteDate },
        },
        { $set: { voteDate: procedureUpdate.voteDate } },
      );
    });
  } catch (error) {
    Log.error(`Conference Week Detail Scraper failed ${error.message}`);
  }
  Log.info('FINISH CONFERENCE WEEK DETAIL SCRAPER');
};
