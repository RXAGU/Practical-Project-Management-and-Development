import papa from 'papaparse';
import fs from 'fs/promises'; 
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config();

//supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const OUTPUT_FILE = 'Companies-Data.json';
const CREATIVE_OUTPUT = 'Creatives.json';


// url to scrape creative industries logos and website
const CREATIVE_AGENCIES_URL = 'https://www.designrush.com/agency/creative-agencies/uk';   
const GRAPHIC_DESIGN_URL = 'https://www.designrush.com/agency/graphic-design';   
const VIDEO_PRODUCTION_URL= 'https://www.designrush.com/agency/video-production';   
const PRODUCT_DESIGN_URL= 'https://www.designrush.com/agency/video-production';   

async function addDataToSupabase(scrapedData, tableName = 'company_data_table') {
  try {
    console.log(`Inserting ${scrapedData.length} records into ${tableName}...`);
    
    const { data, error } = await supabase
      .from(tableName)
      .insert(scrapedData);
    
    if (error) {
      console.error(`Error inserting data into ${tableName}:`, error);
      return false;
    }
    
    console.log(`Data inserted successfully into ${tableName}:`, data);
    return true;
  } catch (err) {
    console.error(`Exception when inserting data into ${tableName}:`, err);
    return false;
  }
}



/**
 * Converts a CSV file to JSON and saves it to a file.
 * @param {string} csvFile - The name of the CSV file.
 * @param {number} maxRows - The maximum number of rows to parse.
 * @returns {Promise<void>}
 */
async function csvToJson(csvFile, maxRows = 0) {
    try {
        const data = await fs.readFile(csvFile, 'utf-8'); // Read the CSV file
        let result = [];
        let rowCount = 0;

        papa.parse(data, {
            header: true,
            step: function (row, parser) {
                if (rowCount >= maxRows) {
                    parser.abort();
                    console.log("Max Row Count Reached.");
                    return;
                }
                result.push(row.data);
                rowCount++;
            },
            complete: async function () {
                try {
                    await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2)); // Write JSON to file
                    console.log(`✅ Data successfully written to ${OUTPUT_FILE}`);
                } catch (err) {
                    console.log('❌ Error writing to file:', err);
                }
            }
        });
    } catch (err) {
        console.log("❌ Error reading file:", err);
    }
}

/**
 * Scrapes information about the creative agencies links on design rush.
 * 
 * @async
 * @function ScrapeCreativeAgencies
 * @param websiteUrl -- link for puppeteer to go to.
 * @description navigate through all possible pages scraping logo image and also name and details.
 * 
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of product objects.
 * Each product object contains:
 *   - name {string} The product name
 *   -logoUrl {string|null} URL to the product image
 *   -website {string | null} URL for the comapanies website
 * 
 * @throws {Error} If any error occurs during scraping or file operations
 * 
 */
async function scrapeCreativeAgencies(websiteUrl) {
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: ["--window-size=1200,8000"],
    });
    let hasMorePages = true;
    let currentPage = 1;
    const elements = [];
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      // Loop through all pages
      while (hasMorePages) {
        const pageUrl = currentPage === 1 ? websiteUrl : `${websiteUrl}?page=${currentPage}`;
        console.log(`Navigating to page ${currentPage}: ${pageUrl}...`);
        await page.goto(pageUrl, {waitUntil: 'networkidle2'});
        console.log('Waiting for elements to load...');
        
        // Check if agencies exist on this page
        const hasAgencies = await page.evaluate(() => {
          return document.querySelectorAll('.agency-item--inner').length > 0;
        });
        
        if (!hasAgencies) {
          console.log(`No agencies found on page ${currentPage}. Ending pagination.`);
          hasMorePages = false;
          break;
        }
        
        // Extract agency information
        const pageElements = await page.evaluate(() => {
          const companyElements = Array.from(document.querySelectorAll('.agency-item--inner'));
          return companyElements.map((company) => {
            // Get company name
            const nameElement = company.querySelector('h3.title a');
            const companyName = nameElement ? nameElement.textContent.trim() : 'No name found';
            
            // Get logo URL
            const imageElement = company.querySelector('.logo img');
            const logoUrl = imageElement ? imageElement.getAttribute('src') : null;
            
            // Get company website
            const websiteElement = company.querySelector('h3.title a');
            const companyWebsite = websiteElement ? websiteElement.getAttribute('href') : null;
            
            // Get location
            const locationElement = company.querySelector('address');
            const location = locationElement ? locationElement.textContent.trim() : null;
            
            
            return {
              name: companyName,
              logoUrl: logoUrl,
              website: companyWebsite,
              location: location,
            };
          });
        });
        
        console.log(`Found ${pageElements.length} agencies on page ${currentPage}`);
        elements.push(...pageElements);


        //immediately add to supabase
        // Process each company individually
        for (const company of pageElements) {
          await addDataToSupabase([company]);
        }
        
        // Check if there's a next page
        const hasNextPage = await page.evaluate(() => {
          const paginationItems = document.querySelectorAll('.pagination .page-item');
          const activePageItem = document.querySelector('.pagination .page-item.active');
          
          if (!activePageItem) return false;
          
          const activePageNumber = parseInt(activePageItem.textContent.trim(), 10);
          return activePageItem.nextElementSibling !== null && paginationItems.length > activePageNumber;
        });
        
        if (hasNextPage) {
          currentPage++;
        } else {
          console.log(`Reached last page (${currentPage}). Ending pagination.`);
          hasMorePages = false;
        }
      }
      
      // Save all the data to the JSON file
      console.log(`Saving ${elements.length} agencies to ${CREATIVE_OUTPUT}`);
      await fs.writeFile(CREATIVE_OUTPUT, JSON.stringify(elements, null, 2));
      console.log('Data saved successfully!');
      
      await browser.close();
      return elements;
    } catch(error) {
      console.log('Error during scraping', error);
      await browser.close();
      return [];
    }
  }

function main() {
  try {
    scrapeCreativeAgencies(CREATIVE_AGENCIES_URL);
    scrapeCreativeAgencies(GRAPHIC_DESIGN_URL);
    scrapeCreativeAgencies(PRODUCT_DESIGN_URL);
    scrapeCreativeAgencies(VIDEO_PRODUCTION_URL);
  } catch (error) {
    console.error("Error in main execution", error);
  }
}

main();


  