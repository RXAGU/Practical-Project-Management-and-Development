import puppeteer from 'puppeteer-extra';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin())

dotenv.config();

//supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); 

// Constants 
const JESSOPS_URL= 'https://www.jessops.com/accessories/flash';
const OUTPUT_FILE = 'equipment.json';


/**
 * Inserts scraped data into a specified Supabase table.
 *
 * @async
 * @function addDataToSupabase
 * @param {Array<Object>} scrapedData - An array of objects containing the data to be inserted.
 * @param {string} [tableName='equipment_data_table'] - The name of the table where data should be inserted (default is 'skills_data_table').
 * @returns {Promise<boolean>} - Returns `true` if insertion is successful, otherwise `false`.
 */
async function addDataToSupabase(scrapedData, tableName = 'equipment_data_table') {
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
 * Scrapes product information from all pages of the Jessops cameras section.
 * 
 * @async
 * @function ScrapeJessops
 * @description Navigates through all available pages of the Jessops cameras section,
 * extracting product details including name, image URL, price, and feature list.
 * The function saves all scraped data to a JSON file and returns the collected data.
 * 
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of product objects.
 * Each product object contains:
 *   - name {string} The product name
 *   - imageUrl {string|null} URL to the product image
 *   - features {Array<string>} List of product features
 * 
 * @throws {Error} If any error occurs during scraping or file operations
 * 
 */
async function ScrapeJessops() {
  const browser = await puppeteer.launch({headless: false, defaultViewport: null, args: ['--window-size=1200,8000']});
  let currentPage = 1;
  let hasMorePages = true;
  const equipments = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Loop through all pages
    while (hasMorePages) {
      const pageUrl = currentPage === 1 ? JESSOPS_URL : `${JESSOPS_URL}?pg=${currentPage}`;
      console.log(`Navigating to page ${currentPage}: ${pageUrl}...`);
      await page.goto(pageUrl, {waitUntil: 'networkidle2'});
      console.log('Waiting for elements to load...');
      
      // Check if products exist on this page
      const hasProducts = await page.evaluate(() => {
        return document.querySelectorAll('.f-grid.prod-row').length > 0;
      });
      
      if (!hasProducts) {
        console.log(`No products found on page ${currentPage}. Ending pagination.`);
        hasMorePages = false;
        break;
      }
      
      // Extract product information
      const pageEquipments = await page.evaluate(() => {
        const productElements = Array.from(document.querySelectorAll('.f-grid.prod-row'));
        return productElements.map((product) => {
          // Get product name
          const nameElement = product.querySelector('h4');
          const productName = nameElement ? nameElement.textContent.trim() : 'No name found';
          
          // Get image URL
          const imageElement = product.querySelector('.image img');
          const imageUrl = imageElement ? imageElement.getAttribute('src') : null;

          // Get product features
          const featureElements = product.querySelectorAll('.f-list.j-list li');
          const features = Array.from(featureElements).map(li => li.textContent.trim());
         
          // Process the product name to remove everything after "in" and replace "body" with empty string
          let finalProductName = productName;
          const inIndex = productName.indexOf(' in ');
          if (inIndex !== -1) {
            // Remove everything after " in "
            finalProductName = productName.substring(0, inIndex);
          }

          // Replace "body" with empty string
          finalProductName = finalProductName.replace(/\b(?:body|used)\b/gi, '').trim();
          // Clean up any double spaces left after replacements
          finalProductName = finalProductName.replace(/\s+/g, ' ').trim();
          
          return {
            name: finalProductName,
            imageUrl: imageUrl,
            features: features,
            equipment_type: 'camera accessories'
          };
        });
      });
      
      console.log(`Found ${pageEquipments.length} products on page ${currentPage}`);
      equipments.push(...pageEquipments);
      

      //immediately add to supabase
        // Process each product individually
        for (const product of pageEquipments) {
          try {
            await addDataToSupabase([product]);
          } catch (err) {
            console.error('Failed to add product:', product.name, err);
          }
          
        }

      
      // Check if there's a next page
      const lastPage = await page.evaluate(() => {
        const lastPageElement = document.querySelector('#url-info');
        return lastPageElement ? parseInt(lastPageElement.getAttribute('data-last-page'), 10) : null;
      });
      
      if (lastPage && currentPage < lastPage) {
        currentPage++;
      } else {
        console.log(`Reached last page (${currentPage}). Ending pagination.`);
        hasMorePages = false;
      }
      
    }
    
    // Save all the data to the JSON file
    console.log(`Saving ${equipments.length} products to ${OUTPUT_FILE}`);
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(equipments, null, 2));
    console.log('Data saved successfully!');
    
    await browser.close();
    return equipments;
  } catch(error) {
    console.log('Error during scraping', error);
    await browser.close();
    return [];
  }
}

async function testSupabaseConnection() {
  try {
    // Option 2: Fetch a small amount of data just to test connection
    const { data, error } = await supabase
      .from('equipment_data_table')
      .select('*')
      .limit(1);
     
    if (error) throw error;
    console.log('Supabase connection successful!');
    return true;
  } catch (err) {
    console.error('Supabase connection test failed:', err);
    return false;
  }
}


console.log(`API url: ${process.env.SUPABASE_URL}\n, API key: ${process.env.SUPABASE_KEY}`);
ScrapeJessops();
