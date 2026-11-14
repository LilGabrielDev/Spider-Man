import axios from 'axios';
import { API_CONFIG } from '../france/config.js';
import { t, getUserLang } from '../france/translator.js';
import { safeDeleteTempMessage } from '../../spider/utils/groupActionHelper.js';

export const commands = [
  {
    name: 'country',
    aliases: ['countryinfo', 'nation', 'negara'],
    description: 'Get detailed information about a country',
    category: 'Search',
    execute: async ({ sock, from, text, msg, config }) => {
      const botName = config.BOT_NAME || 'Spider Man';
      if (!text || text.trim() === '') {
        const noCountry = await t(from, 'country', 'noCountry');
        return sock.sendMessage(from, { text: noCountry }, { quoted: msg });
      }

      const query = text.trim();
      const url = `${API_CONFIG.country.url}?name=${encodeURIComponent(query)}`;
      let tempMsg = null;

      try {
        const fetching = await t(from, 'country', 'fetching');
        tempMsg = await sock.sendMessage(from, { text: `${fetching} ${query}...` }, { quoted: msg });
        const response = await axios.get(url, {
          timeout: API_CONFIG.country.timeout,
          headers: { Accept: 'application/json' },
        });
        await safeDeleteTempMessage(sock, from, tempMsg);

        if (!response.data.status || !response.data.data) {
          const notFound = await t(from, 'country', 'notFound');
          return sock.sendMessage(from, { text: `${notFound} "${query}"` }, { quoted: msg });
        }

        const data = response.data.data;
        getUserLang(from);
        const phoneCode = data.phoneCode || 'N/A';
        const areaText = data.area
          ? `${data.area.squareKilometers.toLocaleString()} km² / ${data.area.squareMiles.toLocaleString()} mi²`
          : 'N/A';
        const neighborsText = data.neighbors ? data.neighbors.map((n) => n.name).join(', ') : 'None';
        const languagesText = data.languages?.native ? data.languages.native.join(', ') : 'N/A';
        const coordsText = data.coordinates
          ? `${data.coordinates.latitude}, ${data.coordinates.longitude}`
          : 'N/A';

        const header = await t(from, 'country', 'header');
        const nameLbl = await t(from, 'country', 'name');
        const capitalLbl = await t(from, 'country', 'capital');
        const phoneLbl = await t(from, 'country', 'phoneCode');
        const continentLbl = await t(from, 'country', 'continent');
        const langsLbl = await t(from, 'country', 'languages');
        const currencyLbl = await t(from, 'country', 'currency');
        const areaLbl = await t(from, 'country', 'area');
        const drivingLbl = await t(from, 'country', 'drivingSide');
        const landlockedLbl = await t(from, 'country', 'landlocked');
        const govLbl = await t(from, 'country', 'government');
        const coordsLbl = await t(from, 'country', 'coordinates');
        const isoLbl = await t(from, 'country', 'isoCode');
        const mapsLbl = await t(from, 'country', 'googleMaps');
        const famousLbl = await t(from, 'country', 'famousFor');
        const neighborsLbl = await t(from, 'country', 'neighbors');
        const yesLbl = await t(from, 'country', 'yes');
        const noLbl = await t(from, 'country', 'no');
        const powered = await t(from, 'country', 'powered');

        let reply = `${header}\n\n`;
        reply += `${nameLbl} ${data.name}\n`;
        reply += `${capitalLbl} ${data.capital || 'N/A'}\n`;
        reply += `${phoneLbl} ${phoneCode}\n`;
        reply += `${continentLbl} ${data.continent?.name || 'N/A'} ${data.continent?.emoji || ''}\n`;
        reply += `${langsLbl} ${languagesText}\n`;
        reply += `${currencyLbl} ${data.currency || 'N/A'}\n`;
        reply += `${areaLbl} ${areaText}\n`;
        reply += `${drivingLbl} ${data.drivingSide || 'N/A'}\n`;
        reply += `${landlockedLbl} ${data.landlocked ? yesLbl : noLbl}\n`;
        reply += `${govLbl} ${data.constitutionalForm || 'N/A'}\n`;
        reply += `${coordsLbl} ${coordsText}\n`;
        reply += `${isoLbl} ${data.isoCode?.alpha2?.toUpperCase() || 'N/A'}\n`;
        reply += `${mapsLbl} ${data.googleMapsLink || 'N/A'}\n`;
        reply += `${famousLbl} ${data.famousFor || 'N/A'}\n`;
        if (data.neighbors && data.neighbors.length > 0) {
          reply += `${neighborsLbl} ${neighborsText}\n`;
        }
        reply += `\n${powered} ${botName}`;

        if (data.flag) {
          await sock.sendMessage(from, { image: { url: data.flag }, caption: reply }, { quoted: msg });
        } else {
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
        }
      } catch (err) {
        console.error('Country info error:', err);
        await safeDeleteTempMessage(sock, from, tempMsg);
        const errMsg = await t(from, 'country', 'error');
        const powered = await t(from, 'country', 'powered');
        await sock.sendMessage(from, { text: `${errMsg}\n\n${powered} ${botName}` }, { quoted: msg });
      }
    },
  },
];